import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { parquetMetadataAsync, parquetRead } from "hyparquet";
import { S3AsyncBuffer } from "../../lib/s3-async-buffer";

export const runtime = "nodejs";

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = "f1-telemetry-datalake-gabriel";
const SILVER_PREFIX = "data/silver/telemetry";

// Driver, Year y GrandPrix viven en el nombre de la carpeta, no adentro del
// Parquet. Por eso no se piden acá: ya los conocemos por la ruta.
const COLUMNS = [
  "LapNumber", "Distance", "Speed", "RPM", "nGear", "Throttle", "Brake", "DRS", "X", "Y",
  "Compound",
];

// El nombre del part-*.parquet lo genera Spark y cambia en cada corrida.
// Se resuelve por prefijo y se cachea en memoria del proceso: sin esto,
// cada request se come un ListObjectsV2 de más.
const keyCache = new Map<string, string>();

// Las filas del piloto también se cachean. Sin esto, cambiar de vuelta vuelve
// a bajar y decodificar el Parquet entero de la carrera: son ~40.000 filas
// para devolver 700. Pocas entradas, porque cada una ocupa varios MB.
const rowsCache = new Map<string, { rows: Row[]; hasta: number }>();
const ROWS_TTL_MS = 5 * 60 * 1000;
const ROWS_MAX = 4;

async function resolveParquetKey(prefix: string): Promise<string | null> {
  const cached = keyCache.get(prefix);
  if (cached) return cached;

  const res = await s3Client.send(
    new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, MaxKeys: 100 })
  );

  const key = res.Contents?.find(
    (o) => o.Key?.endsWith(".parquet") && !o.Key.split("/").pop()!.startsWith(".")
  )?.Key;

  if (key) keyCache.set(prefix, key);
  return key ?? null;
}

type Row = Record<string, number | string>;

// hyparquet entrega los datos por callback, no por return.
function readRows(file: S3AsyncBuffer, columns: string[]): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    parquetRead({
      file,
      columns,
      rowFormat: "object",
      onComplete: (rows) => resolve(rows as unknown as Row[]),
    }).catch(reject);
  });
}

const r = (n: number, dec = 1) =>
  typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(dec)) : 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const year = searchParams.get("year") ?? "2024";
    const gp = searchParams.get("gp") ?? "silverstone";
    const driver = (searchParams.get("driver") ?? "VER").toUpperCase();
    const lapParam = searchParams.get("lap");
    const debug = searchParams.get("debug");

    const prefix = `${SILVER_PREFIX}/Year=${year}/GrandPrix=${gp}/Driver=${driver}/`;
    const key = await resolveParquetKey(prefix);

    if (!key) {
      return NextResponse.json(
        {
          status: "error",
          message: `No hay datos para ${driver} en ${gp} ${year}.`,
          prefijo_buscado: prefix,
        },
        { status: 404 }
      );
    }

    const buffer = await S3AsyncBuffer.create(s3Client, BUCKET_NAME, key);
    const metadata = await parquetMetadataAsync(buffer);
    const numRows = Number(metadata.num_rows);

    if (debug === "schema") {
      return NextResponse.json({
        status: "success",
        key,
        num_rows: numRows,
        columns: metadata.schema.map((c: { name: string }) => c.name),
      });
    }

    if (numRows === 0) {
      return NextResponse.json(
        { status: "error", message: "La partición existe pero está vacía." },
        { status: 400 }
      );
    }

    const cacheKey = `${year}|${gp}|${driver}`;
    const enCache = rowsCache.get(cacheKey);

    let rows: Row[];
    if (enCache && Date.now() < enCache.hasta) {
      rows = enCache.rows;
    } else {
      rows = await readRows(buffer, COLUMNS);

      // Las muestras sin posición quedan en (0,0) por el fillna de la ingesta.
      // Dibujadas, hacen que el trazo salte al origen y vuelva, partiendo el
      // circuito en pedazos. No son datos, son huecos.
      const antes = rows.length;
      rows = rows.filter((row) => Number(row.X) !== 0 || Number(row.Y) !== 0);
      if (rows.length < antes) {
        console.warn(`${cacheKey}: descartadas ${antes - rows.length} muestras sin posición`);
      }

      // Se descarta la entrada más vieja antes de agregar una nueva.
      if (rowsCache.size >= ROWS_MAX) {
        const primera = rowsCache.keys().next().value;
        if (primera) rowsCache.delete(primera);
      }
      rowsCache.set(cacheKey, { rows, hasta: Date.now() + ROWS_TTL_MS });
    }

    const lapsDisponibles = [...new Set(rows.map((row) => Number(row.LapNumber)))].sort(
      (a, b) => a - b
    );

    // El orden de las filas de un Parquet no está garantizado: Spark las
    // escribe según cómo particionó, no según el recorrido. Sin ordenar por
    // distancia, unir los puntos con líneas dibuja el circuito hecho pedazos.
    rows.sort((a, b) => Number(a.Distance) - Number(b.Distance));

    let selected = rows;
    let lapElegida: number | null = null;

    if (lapParam) {
      const lap = Number(lapParam);
      selected = rows.filter((row) => Number(row.LapNumber) === lap);
      lapElegida = lap;

      if (selected.length === 0) {
        return NextResponse.json(
          {
            status: "error",
            message: `El piloto ${driver} no tiene registrada la vuelta ${lap}.`,
            laps_disponibles: lapsDisponibles,
          },
          { status: 404 }
        );
      }
    } else {
      // Sin vuelta puntual se elige una representativa, no la carrera entera:
      // Distance se reinicia en cada vuelta, así que devolver todo junto
      // superpone 50 vueltas en el mismo eje y no se entiende nada.
      // Se toma la del medio: evita la largada y el final con goma gastada.
      const media = lapsDisponibles[Math.floor(lapsDisponibles.length / 2)];
      selected = rows.filter((row) => Number(row.LapNumber) === media);
      lapElegida = media;
    }

    // Dentro de la vuelta el orden ya viene por distancia, pero se reordena
    // igual por si la selección mezcló tramos.
    selected.sort((a, b) => Number(a.Distance) - Number(b.Distance));

    // Extremos de X/Y para armar el viewBox del SVG sin recorrer todo en el cliente.
    const xs = selected.map((row) => Number(row.X));
    const ys = selected.map((row) => Number(row.Y));

    const telemetry = selected.map((row) => ({
      lap: Number(row.LapNumber),
      compound: String(row.Compound ?? ""),
      distance: r(Number(row.Distance)),
      speed: r(Number(row.Speed)),
      rpm: Math.round(Number(row.RPM)),
      gear: Number(row.nGear),
      throttle: Math.round(Number(row.Throttle)),
      brake: Number(row.Brake) ? 1 : 0,
      drs: Number(row.DRS),
      x: Math.round(Number(row.X)),
      y: Math.round(Number(row.Y)),
    }));

    return NextResponse.json({
      status: "success",
      year: Number(year),
      gp,
      driver,
      lap: lapElegida,
      laps_disponibles: lapsDisponibles,
      points: telemetry.length,
      bounds: {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      },
      telemetry,
    });
  } catch (error) {
    console.error("Error procesando Parquet:", error);
    return NextResponse.json(
      {
        status: "error",
        message: "Fallo al procesar la telemetría",
        details: String(error),
      },
      { status: 500 }
    );
  }
}
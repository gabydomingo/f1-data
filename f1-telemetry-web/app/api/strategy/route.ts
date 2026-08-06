import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET_NAME = "f1-telemetry-datalake-gabriel";
const KEY_PREDICCIONES = "data/gold/predicciones.json";
// El modelo está partido por era reglamentaria: se prueban las claves
// conocidas y se usa la primera que exista.
const KEYS_METRICAS = ["models/metrics_2024-2025.json", "models/metrics_2026.json"];

type Prediccion = {
  year: number;
  gp: string;
  driver: string;
  compound_inicial: string;
  compound_siguiente: string;
  total_vueltas: number;
  pit_window: number | null;
  pit_real: number | null;
  error_vueltas: number | null;
  degradacion_s_vuelta: number;
};

// Los dos archivos solo cambian cuando corre el pipeline: se cachean en
// memoria del proceso para no bajarlos en cada request.
let cache: { predicciones: Prediccion[]; resumen: unknown; modelo: unknown; hasta: number } | null =
  null;
const TTL_MS = 10 * 60 * 1000;

async function leerJson(key: string) {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const texto = await res.Body?.transformToString();
  if (!texto) throw new Error(`${key} llegó vacío`);
  return JSON.parse(texto);
}

async function cargar() {
  if (cache && Date.now() < cache.hasta) return cache;

  const pred = await leerJson(KEY_PREDICCIONES);

  // Las métricas son opcionales: si el modelo no se exportó todavía,
  // la tarjeta igual puede mostrar la predicción.
  let modelo: unknown = null;
  for (const key of KEYS_METRICAS) {
    try {
      modelo = await leerJson(key);
      break;
    } catch {
      // Esa era no está publicada en el bucket: se prueba la siguiente.
    }
  }

  const { predicciones, ...resumen } = pred;
  cache = { predicciones, resumen, modelo, hasta: Date.now() + TTL_MS };
  return cache;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const year = Number(searchParams.get("year") ?? 2024);
    const gp = searchParams.get("gp");
    const driver = searchParams.get("driver")?.toUpperCase();

    const { predicciones, resumen, modelo } = await cargar();

    const prediccion =
      gp && driver
        ? predicciones.find((p) => p.year === year && p.gp === gp && p.driver === driver) ?? null
        : null;

    return NextResponse.json({ status: "success", prediccion, resumen, modelo });
  } catch (error) {
    console.error("Error leyendo la estrategia:", error);
    return NextResponse.json(
      {
        status: "error",
        message: "No se pudieron leer las predicciones. ¿Corriste src/predicciones.py y el sync?",
        details: String(error),
      },
      { status: 500 }
    );
  }
}

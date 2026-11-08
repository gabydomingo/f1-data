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
// El modelo está partido por era reglamentaria: 2024 y 2025 comparten
// reglamento, 2026 estrena autos y motores.
//
// Antes acá se probaban las claves conocidas y se usaba la primera que
// existiera. Como metrics_2024-2025.json siempre está, una carrera de 2026
// devolvía las métricas de la era vieja y el modelo 2026 era inalcanzable.
// Se elige por año, con el mismo corte que usan los scripts y el workflow.
function eraDe(year: number): string {
  return year >= 2026 ? "2026" : "2024-2025";
}

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

// Los archivos solo cambian cuando corre el pipeline: se cachean en memoria
// del proceso para no bajarlos en cada request. Las métricas van en su propio
// cache por era, porque ahora dependen del año que se pida.
let cachePred: { predicciones: Prediccion[]; resumen: unknown; hasta: number } | null = null;
const cacheMetricas = new Map<string, { modelo: unknown; hasta: number }>();
const TTL_MS = 10 * 60 * 1000;

async function leerJson(key: string) {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const texto = await res.Body?.transformToString();
  if (!texto) throw new Error(`${key} llegó vacío`);
  return JSON.parse(texto);
}

async function cargarPredicciones() {
  if (cachePred && Date.now() < cachePred.hasta) return cachePred;

  const pred = await leerJson(KEY_PREDICCIONES);
  const { predicciones, ...resumen } = pred;
  cachePred = { predicciones, resumen, hasta: Date.now() + TTL_MS };
  return cachePred;
}

async function cargarMetricas(year: number) {
  const era = eraDe(year);
  const guardado = cacheMetricas.get(era);
  if (guardado && Date.now() < guardado.hasta) return guardado.modelo;

  // Son opcionales: si esa era todavía no se entrenó, la tarjeta igual
  // muestra la predicción. No se cae a la otra era a propósito: un null es
  // honesto, las métricas del reglamento equivocado no.
  let modelo: unknown = null;
  try {
    modelo = await leerJson(`models/metrics_${era}.json`);
  } catch {
    // Esa era no está publicada en el bucket.
  }

  cacheMetricas.set(era, { modelo, hasta: Date.now() + TTL_MS });
  return modelo;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const year = Number(searchParams.get("year") ?? 2024);
    const gp = searchParams.get("gp");
    const driver = searchParams.get("driver")?.toUpperCase();

    const [{ predicciones, resumen }, modelo] = await Promise.all([
      cargarPredicciones(),
      cargarMetricas(year),
    ]);

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

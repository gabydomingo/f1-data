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
const KEY = "data/gold/catalogo.json";

// El catálogo solo cambia cuando corre el pipeline, así que se cachea en
// memoria del proceso. Sin esto, cada carga del dashboard baja el JSON de S3.
let cache: { data: unknown; hasta: number } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function GET() {
  try {
    if (cache && Date.now() < cache.hasta) {
      return NextResponse.json(cache.data);
    }

    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: KEY })
    );

    const texto = await res.Body?.transformToString();
    if (!texto) throw new Error("El catálogo llegó vacío");

    const data = JSON.parse(texto);
    cache = { data, hasta: Date.now() + TTL_MS };

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error leyendo el catálogo:", error);
    return NextResponse.json(
      {
        status: "error",
        message: "No se pudo leer el catálogo. ¿Corriste src/catalogo.py y el sync a S3?",
        details: String(error),
      },
      { status: 500 }
    );
  }
}

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

// Inicializamos el cliente de AWS de forma segura usando las variables de entorno
const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export async function GET() {
  try {
    // Apuntamos exactamente a tu bucket y a la carpeta silver
    // Al dejar el Prefix vacío, AWS listará todos los archivos del bucket
    const command = new ListObjectsV2Command({
      Bucket: "f1-telemetry-datalake-gabriel", 
      Prefix: "", 
    });

    const response = await s3Client.send(command);

    // Si todo sale bien, devolvemos la lista de archivos encontrados
    return NextResponse.json({
      status: "success",
      message: "Conexión a AWS S3 exitosa",
      files: response.Contents?.map((item) => item.Key) || [],
    });

  } catch (error) {
    console.error("Error conectando a S3:", error);
    return NextResponse.json(
      { status: "error", message: "Fallo al conectar con el Data Lake" },
      { status: 500 }
    );
  }
}
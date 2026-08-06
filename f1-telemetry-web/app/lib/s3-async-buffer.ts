import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

/**
 * Adaptador que le presenta a hyparquet un objeto de S3 como si fuera un
 * archivo local. Expone `byteLength` y `slice()`, que es la interfaz mínima
 * que la librería espera.
 *
 * Sirve para no descargar el Parquet entero: hyparquet lee primero el footer
 * con el índice y después pide solo los bloques de las columnas que necesita.
 * Cada pedido se traduce en un GetObject con cabecera Range.
 */
export class S3AsyncBuffer {
  public byteLength: number;
  
  private constructor(
    private s3: S3Client,
    private bucket: string,
    private key: string,
    byteLength: number
  ) {
    this.byteLength = byteLength;
  }

  // El constructor no puede ser async y el tamaño hay que conocerlo de entrada:
  // hyparquet lo usa para ubicar el footer antes de pedir ningún dato.
  static async create(s3: S3Client, bucket: string, key: string): Promise<S3AsyncBuffer> {
    const headCmd = new HeadObjectCommand({ Bucket: bucket, Key: key });
    const head = await s3.send(headCmd);
    const byteLength = head.ContentLength || 0;
    return new S3AsyncBuffer(s3, bucket, key, byteLength);
  }

  /** Trae el tramo [start, end) del objeto. Es lo que invoca hyparquet. */
  async slice(start: number, end: number): Promise<ArrayBuffer> {
    // El rango de HTTP incluye el último byte y el de slice() no, de ahí el -1.
    const range = `bytes=${start}-${end - 1}`;
    
    const getCmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      Range: range,
    });

    const response = await this.s3.send(getCmd);
    
    // El SDK v3 devuelve un stream; transformToByteArray lo consume entero.
    // Son fragmentos de pocos MB, así que no hace falta procesarlo por partes.
    const byteArray = await response.Body?.transformToByteArray();

    if (!byteArray) {
      throw new Error("Fallo al leer el fragmento de S3");
    }

    // Se copia a un ArrayBuffer propio: el tipo del SDK es ArrayBufferLike y
    // puede llegar respaldado por un SharedArrayBuffer, que hyparquet rechaza.
    const uint8 = new Uint8Array(byteArray);
    const result = new ArrayBuffer(uint8.length);
    new Uint8Array(result).set(uint8);
    return result;
  }
}
"""
Capa de publicación: sube el data lake local a S3.

Hace lo mismo que `aws s3 sync` pero con boto3, que ya es dependencia del
proyecto. Evita tener que instalar y configurar el CLI en la máquina donde se
ingesta.

Dos decisiones que importan:

- Nunca borra nada del bucket. Sincronizar es subir lo que falta o cambió, no
  espejar. Si una partición existe arriba y no abajo, se queda arriba: eso es
  lo que evitó perder el silver cuando una corrida procesó de menos.
- Se saltean los .crc y los _SUCCESS de Spark, que son metadatos del escritor
  y no datos.

Variables de entorno:
    F1_BUCKET  Bucket del data lake.

Uso:
    python src/sincronizar_s3.py                      # sube data/silver
    python src/sincronizar_s3.py --que silver gold models
    python src/sincronizar_s3.py --simular            # no sube, solo informa
"""

import argparse
import hashlib
import os
import sys

BUCKET = os.environ.get("F1_BUCKET", "f1-telemetry-datalake-gabriel")

# Qué carpeta local va a qué prefijo del bucket.
DESTINOS = {
    "silver": ("data/silver", "data/silver"),
    "gold": ("data/gold", "data/gold"),
    "models": ("models", "models"),
}

IGNORAR = (".crc", "_SUCCESS")

_cliente_s3 = None


def s3():
    """Cliente boto3, creado recién cuando hace falta."""
    global _cliente_s3
    if _cliente_s3 is None:
        import boto3

        _cliente_s3 = boto3.client("s3")
    return _cliente_s3


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for bloque in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloque)
    return h.hexdigest()


def remotos(prefijo: str) -> dict:
    """{clave: (tamaño, etag)} de todo lo que ya está bajo ese prefijo."""
    encontrados = {}
    pag = s3().get_paginator("list_objects_v2")
    for pagina in pag.paginate(Bucket=BUCKET, Prefix=prefijo + "/"):
        for obj in pagina.get("Contents", []):
            encontrados[obj["Key"]] = (obj["Size"], obj["ETag"].strip('"'))
    return encontrados


def hay_que_subir(local: str, ya_esta) -> bool:
    """
    True si el archivo no está arriba o cambió.

    El ETag de un objeto subido en una sola parte es su MD5. Cuando boto3 parte
    el archivo, el ETag trae un sufijo '-N' y deja de ser comparable: ahí se
    cae a comparar el tamaño, que para un Parquet reescrito alcanza.
    """
    if ya_esta is None:
        return True

    tamano_remoto, etag = ya_esta
    if os.path.getsize(local) != tamano_remoto:
        return True
    if "-" in etag:
        return False
    return md5(local) != etag


def sincronizar(carpeta: str, prefijo: str, simular: bool) -> tuple:
    if not os.path.isdir(carpeta):
        print(f"AVISO: no existe {carpeta}, se saltea")
        return 0, 0, 0

    print(f"\n=== {carpeta}  ->  s3://{BUCKET}/{prefijo} ===")
    ya_arriba = remotos(prefijo)

    subidos = iguales = bytes_subidos = 0

    for raiz, _, archivos in os.walk(carpeta):
        for nombre in sorted(archivos):
            if nombre.endswith(IGNORAR) or nombre.startswith("."):
                continue

            local = os.path.join(raiz, nombre)
            relativo = os.path.relpath(local, carpeta).replace(os.sep, "/")
            clave = f"{prefijo}/{relativo}"

            if not hay_que_subir(local, ya_arriba.get(clave)):
                iguales += 1
                continue

            peso = os.path.getsize(local)
            if simular:
                print(f"  [simulado] {clave}  ({peso / 1024**2:.1f} MB)")
            else:
                s3().upload_file(local, BUCKET, clave)
                print(f"  subido {clave}  ({peso / 1024**2:.1f} MB)")

            subidos += 1
            bytes_subidos += peso

    print(f"--- {subidos} para subir, {iguales} sin cambios, "
          f"{bytes_subidos / 1024**2:.1f} MB")
    return subidos, iguales, bytes_subidos


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--que", nargs="+", choices=list(DESTINOS), default=["silver"],
                        help="Qué capas subir (por defecto: silver)")
    parser.add_argument("--simular", action="store_true",
                        help="Lista lo que subiría, sin subir nada")
    args = parser.parse_args()

    total_sub = total_bytes = 0
    for capa in args.que:
        carpeta, prefijo = DESTINOS[capa]
        sub, _, bytes_ = sincronizar(carpeta, prefijo, args.simular)
        total_sub += sub
        total_bytes += bytes_

    verbo = "se subirían" if args.simular else "subidos"
    print(f"\nRESUMEN: {total_sub} archivos {verbo}, "
          f"{total_bytes / 1024**2:.1f} MB en total")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"ERROR: falló la sincronización. Detalle: {type(e).__name__}: {e}")
        raise

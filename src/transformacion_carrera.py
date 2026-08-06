"""
Capa silver: limpieza y particionado.

Limpia el bronze con PySpark y escribe el silver particionado en estilo Hive
(Year / GrandPrix / Driver), de modo que la API pueda leer un solo archivo por
piloto en vez de escanear la carrera entera.

Uso:
    python src/transformacion_carrera.py

Variables de entorno:
    F1_YEAR  Temporada a transformar (por defecto 2024).
    F1_GPS   Lista de Grandes Premios separados por coma. Si se omite, se
             procesa todo lo que exista en bronze para esa temporada.
"""

import os
from pyspark.sql import SparkSession
from pyspark.sql.functions import col

RAW_DIR = "data/raw/"
SILVER_LAPS_BASE = "data/silver/laps"
SILVER_TEL_BASE = "data/silver/telemetry"
SILVER_EVENTS_BASE = "data/silver/events"


def slug(name: str) -> str:
    return name.replace(" ", "_").lower()


def get_spark():
    spark = (
        SparkSession.builder
        .appName("F1_Silver_Pipeline")
        .master("local[*]")
        .config("spark.driver.memory", "4g")
        # Clave para escalar: con overwrite dinámico, reprocesar Monza NO borra
        # las particiones de los otros circuitos que ya están escritas.
        .config("spark.sql.sources.partitionOverwriteMode", "dynamic")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")
    return spark


def transform_race_data(spark, year: int, grand_prix: str, session_type: str = "R"):
    gp = slug(grand_prix)
    raw_dir = os.path.join(RAW_DIR, str(year), gp)
    raw_laps = os.path.join(raw_dir, f"{session_type}_laps.parquet")
    raw_tel = os.path.join(raw_dir, f"{session_type}_telemetry.parquet")

    print(f"\nINFO: --- Transformando {grand_prix} {year} ---")

    # --- VUELTAS ---
    if os.path.exists(raw_laps):
        df_laps = spark.read.parquet(raw_laps)

        df_laps_clean = (
            df_laps
            .filter(col("LapTime").isNotNull())
            .select(
                col("Year").cast("integer"),
                col("GrandPrix").cast("string"),
                col("Driver").cast("string"),
                col("Team").cast("string"),
                col("LapNumber").cast("integer"),
                col("Stint").cast("integer"),
                col("Compound").cast("string"),
                col("TyreLife").cast("integer"),
                col("LapTime").cast("double"),
                col("Sector1Time").cast("double"),
                col("Sector2Time").cast("double"),
                col("Sector3Time").cast("double"),
            )
            .fillna({"TyreLife": 0})
        )

        (df_laps_clean
            .coalesce(1)
            .write.mode("overwrite")
            .partitionBy("Year", "GrandPrix")
            .parquet(SILVER_LAPS_BASE))
        print(f"SUCCESS: vueltas -> {SILVER_LAPS_BASE}/Year={year}/GrandPrix={gp}/")
    else:
        print(f"WARNING: no hay bronze de vueltas para {gp}")

    # --- EVENTOS DE CARRERA ---
    # Pasan tal cual desde bronze: son pocas filas y ya vienen tipadas.
    raw_ev = os.path.join(raw_dir, f"{session_type}_events.parquet")
    if os.path.exists(raw_ev):
        df_ev = spark.read.parquet(raw_ev)
        (df_ev
            .coalesce(1)
            .write.mode("overwrite")
            .partitionBy("Year", "GrandPrix")
            .parquet(SILVER_EVENTS_BASE))
        print(f"SUCCESS: eventos -> {SILVER_EVENTS_BASE}/Year={year}/GrandPrix={gp}/")

    # --- TELEMETRÍA ---
    if not os.path.exists(raw_tel):
        print(f"WARNING: no hay bronze de telemetría para {gp}")
        return

    df_tel = spark.read.parquet(raw_tel)

    df_tel_clean = df_tel.select(
        col("Year").cast("integer"),
        col("GrandPrix").cast("string"),
        col("Driver").cast("string"),
        col("Team").cast("string"),
        col("LapNumber").cast("integer"),
        col("Compound").cast("string"),
        # Reloj común de la sesión: permite cruzar pilotos entre sí.
        col("SessionTime").cast("double"),
        col("Distance").cast("double"),
        col("Speed").cast("double"),
        col("RPM").cast("integer"),
        col("nGear").cast("integer"),
        col("Throttle").cast("double"),
        col("Brake").cast("boolean").cast("integer"),
        col("DRS").cast("integer"),
        # Posición en pista: X/Y vienen en décimas de metro desde el timing oficial.
        col("X").cast("double"),
        col("Y").cast("double"),
        col("DriverAhead").cast("string"),
        col("DistanceToDriverAhead").cast("double"),
    ).fillna(0)

    # Descarta muestras de box y vueltas de formación: sin esto el minimapa
    # dibuja el pit lane pegado al trazado.
    df_tel_clean = df_tel_clean.filter((col("Speed") > 0) & (col("LapNumber") > 0))

    # repartition antes de partitionBy: garantiza un único archivo por carpeta
    # de piloto, que es lo que hyparquet necesita para leer con Range Requests.
    (df_tel_clean
        .repartition("Driver")
        .write.mode("overwrite")
        .partitionBy("Year", "GrandPrix", "Driver")
        .parquet(SILVER_TEL_BASE))

    print(f"SUCCESS: telemetría -> {SILVER_TEL_BASE}/Year={year}/GrandPrix={gp}/Driver=*/")
    print(f"INFO: filas procesadas: {df_tel_clean.count()}")


if __name__ == "__main__":
    TARGET_YEAR = int(os.environ.get("F1_YEAR", 2024))
    gps_env = os.environ.get("F1_GPS", "").strip()

    if gps_env:
        CALENDARIO = [g.strip() for g in gps_env.split(",") if g.strip()]
    else:
        # Acá no hace falta el calendario: se transforma lo que exista en bronze.
        base = os.path.join(RAW_DIR, str(TARGET_YEAR))
        CALENDARIO = sorted(os.listdir(base)) if os.path.isdir(base) else []

    print(f"INFO: {len(CALENDARIO)} circuitos en bronze de {TARGET_YEAR}")

    spark = get_spark()
    try:
        for gp in CALENDARIO:
            try:
                transform_race_data(spark, TARGET_YEAR, gp)
            except Exception as e:
                print(f"ERROR: falló el job de {gp}. Detalle: {e}")
    finally:
        spark.stop()
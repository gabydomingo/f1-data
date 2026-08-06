"""
Verificación del data lake.

Chequeos rápidos sobre bronze y silver antes de sincronizar con S3: peso en
disco, densidad de muestreo, presencia de coordenadas de posición y estructura
de particiones.

Uso:
    python src/verificar_silver.py --etapa [raw|silver]
"""

import argparse
import os
import pandas as pd

RAW_TEL = "data/raw/2024/silverstone/R_telemetry.parquet"
SILVER_TEL = "data/silver/telemetry"
SILVER_LAPS = "data/silver/laps"


def peso_mb(path: str) -> float:
    if os.path.isfile(path):
        return os.path.getsize(path) / 1024**2
    total = 0
    for root, _, files in os.walk(path):
        total += sum(os.path.getsize(os.path.join(root, f)) for f in files)
    return total / 1024**2


def chequear(df: pd.DataFrame, origen: str, peso: float):
    print(f"\n=== {origen} ===")
    print(f"Peso en disco: {peso:.1f} MB  ->  x24 GPs ≈ {peso * 24 / 1024:.2f} GB")
    print(f"Filas: {len(df):,}")
    print(f"Pilotos: {sorted(df['Driver'].unique())}")

    if "LapNumber" in df.columns:
        print(f"Vueltas: {int(df['LapNumber'].min())} a {int(df['LapNumber'].max())}")
        por_vuelta = df.groupby(['Driver', 'LapNumber']).size()
        print(f"Muestras por vuelta: mediana {int(por_vuelta.median())}, "
              f"min {int(por_vuelta.min())}, max {int(por_vuelta.max())}")

    # El chequeo clave: sin coordenadas no hay minimapa real
    if "X" in df.columns:
        x_ok = df["X"].abs().sum() > 0
        y_ok = df["Y"].abs().sum() > 0
        print(f"Coordenadas X/Y con datos: {x_ok and y_ok}")
        if x_ok:
            print(f"  X: {df['X'].min():.0f} a {df['X'].max():.0f}")
            print(f"  Y: {df['Y'].min():.0f} a {df['Y'].max():.0f}")
        else:
            print("  ALERTA: X/Y en cero. session.load() no trajo pos data.")

    # Distance tiene que reiniciarse en cada vuelta, no acumular la carrera
    if {"Distance", "LapNumber"}.issubset(df.columns):
        una = df[(df["Driver"] == df["Driver"].iloc[0]) & (df["LapNumber"] == df["LapNumber"].min())]
        print(f"Distance en la primera vuelta: {una['Distance'].min():.0f} a {una['Distance'].max():.0f} m")
        print("  (tiene que dar el largo del circuito, ~5900 m en Silverstone)")

    print(f"\nDtypes:\n{df.dtypes}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--etapa", choices=["raw", "silver"], default="silver")
    args = parser.parse_args()

    if args.etapa == "raw":
        df = pd.read_parquet(RAW_TEL)
        chequear(df, "BRONZE · telemetría", peso_mb(RAW_TEL))
    else:
        # pyarrow reconstruye Year/GrandPrix/Driver desde los nombres de carpeta
        df = pd.read_parquet(SILVER_TEL)
        chequear(df, "SILVER · telemetría", peso_mb(SILVER_TEL))

        laps = pd.read_parquet(SILVER_LAPS)
        print(f"\n=== SILVER · vueltas ===")
        print(f"Filas: {len(laps):,} | Circuitos: {laps['GrandPrix'].unique().tolist()}")

        # Una carpeta por piloto es lo que la API necesita para leer un solo archivo
        base = os.path.join(SILVER_TEL, "Year=2024", "GrandPrix=silverstone")
        if os.path.isdir(base):
            carpetas = sorted(os.listdir(base))
            print(f"\nParticiones por piloto: {len(carpetas)}")
            for c in carpetas[:3]:
                archivos = [f for f in os.listdir(os.path.join(base, c)) if f.endswith(".parquet")]
                print(f"  {c} -> {len(archivos)} archivo(s)")
            print("  (si alguno tiene más de 1 archivo, revisar el repartition)")


if __name__ == "__main__":
    main()
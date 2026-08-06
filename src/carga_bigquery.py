"""
Carga del silver en BigQuery.

Sube la telemetría ya limpia a Google BigQuery para consumirla desde Looker
Studio. Es una salida alternativa al dashboard propio: sirve para explorar los
datos con SQL sin levantar la aplicación.

Requiere gcp_credentials.json en la raíz del proyecto (fuera del repositorio).

Uso:
    python src/carga_bigquery.py
"""
"""
Module: Data Warehouse Load
Description: Sube el silver y el gold a BigQuery para consumirlos desde Looker Studio.

             Además de copiar las vueltas, calcula acá las columnas derivadas que
             Looker no puede resolver bien: la corrección por carga de combustible
             y el delta contra el mejor ritmo del piloto. Sin ellas, cualquier
             gráfico de degradación termina mostrando el efecto del combustible,
             que es más grande y va en sentido contrario al desgaste.
"""

import json
import os

import pandas as pd
import pandas_gbq
from google.oauth2 import service_account

SILVER_LAPS = "data/silver/laps"
PREDICCIONES = "data/gold/predicciones.json"
CATALOGO = "data/gold/catalogo.json"
CREDENCIALES = "gcp_credentials.json"

PROJECT_ID = "f1-telemetry-bi"
DATASET = "f1_gold_layer"

# Un F1 gana alrededor de 0,05 s por vuelta a medida que quema combustible.
FUEL_EFFECT = 0.055


def credenciales():
    if not os.path.exists(CREDENCIALES):
        raise FileNotFoundError(f"Falta {CREDENCIALES}")
    return service_account.Credentials.from_service_account_file(CREDENCIALES)


def nombres_circuitos() -> dict:
    """Nombres legibles para los ejes: 'Gran Bretaña' en vez de british_grand_prix."""
    if not os.path.exists(CATALOGO):
        return {}
    with open(CATALOGO, encoding="utf-8") as f:
        cat = json.load(f)
    return {c["slug"]: c["nombre"] for c in cat.get("circuitos", [])}


def preparar_vueltas() -> pd.DataFrame:
    print(f"INFO: leyendo {SILVER_LAPS}...")
    df = pd.read_parquet(SILVER_LAPS)

    df["Year"] = df["Year"].astype(int)
    for col in ("GrandPrix", "Driver", "Team", "Compound"):
        df[col] = df[col].astype(str)

    df = df[df["LapTime"].notna()].copy()

    # Regla del 107% por circuito: saca safety cars, vueltas de box y tráfico.
    limite = (
        df.groupby(["Year", "GrandPrix"], observed=True)["LapTime"].transform("median") * 1.07
    )
    antes = len(df)
    df = df[df["LapTime"] <= limite]
    print(f"INFO: descartadas {antes - len(df)} vueltas por encima del 107%")

    # Corrección de combustible: al principio del stint el auto es más lento por
    # peso, no por la goma. Se le descuenta la penalización proporcional a las
    # vueltas que le quedan por correr.
    total = df.groupby(["Year", "GrandPrix"], observed=True)["LapNumber"].transform("max")
    df["LapTimeFuelAdj"] = df["LapTime"] - FUEL_EFFECT * (total - df["LapNumber"])

    # Delta contra el mejor ritmo del piloto en esa carrera: es lo que hay que
    # graficar contra TyreLife para ver degradación de verdad.
    ref = df.groupby(["Year", "GrandPrix", "Driver"], observed=True)[
        "LapTimeFuelAdj"
    ].transform("min")
    df["DeltaRitmo"] = (df["LapTimeFuelAdj"] - ref).round(3)

    nombres = nombres_circuitos()
    df["Circuito"] = df["GrandPrix"].map(nombres).fillna(df["GrandPrix"])

    # Etiqueta lista para usar como dimensión en Looker
    df["Temporada"] = df["Year"].astype(str)
    df["EsLluvia"] = ~df["Compound"].isin(["SOFT", "MEDIUM", "HARD"])

    return df[[
        "Year", "Temporada", "GrandPrix", "Circuito", "Driver", "Team",
        "LapNumber", "Stint", "Compound", "TyreLife", "EsLluvia",
        "LapTime", "LapTimeFuelAdj", "DeltaRitmo",
        "Sector1Time", "Sector2Time", "Sector3Time",
    ]]


def preparar_predicciones() -> pd.DataFrame:
    if not os.path.exists(PREDICCIONES):
        print(f"WARNING: no existe {PREDICCIONES}")
        return pd.DataFrame()

    with open(PREDICCIONES, encoding="utf-8") as f:
        data = json.load(f)

    df = pd.DataFrame(data.get("predicciones", []))
    if df.empty:
        return df

    nombres = nombres_circuitos()
    df["Circuito"] = df["gp"].map(nombres).fillna(df["gp"])
    df["Temporada"] = df["year"].astype(str)

    # Signo con significado: positivo = el modelo propone parar más tarde que
    # lo que hizo el equipo. Es la métrica que muestra el sesgo del optimizador.
    df["DiferenciaVueltas"] = df["pit_window"] - df["pit_real"]

    return df


def subir(df: pd.DataFrame, tabla: str, creds):
    if df.empty:
        print(f"WARNING: {tabla} vacía, se saltea")
        return
    destino = f"{DATASET}.{tabla}"
    print(f"INFO: subiendo {len(df)} filas a {destino}...")
    pandas_gbq.to_gbq(
        df,
        destino,
        project_id=PROJECT_ID,
        if_exists="replace",
        credentials=creds,
        progress_bar=False,
    )
    print(f"SUCCESS: {destino}")


def main():
    creds = credenciales()

    vueltas = preparar_vueltas()
    print(f"INFO: {len(vueltas)} vueltas en {vueltas['Year'].nunique()} temporadas "
          f"y {vueltas['GrandPrix'].nunique()} circuitos")
    subir(vueltas, "vueltas", creds)

    pred = preparar_predicciones()
    subir(pred, "predicciones", creds)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: falló la carga a BigQuery. Detalle: {e}")
        raise
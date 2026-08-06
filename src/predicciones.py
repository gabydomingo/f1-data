"""
Capa gold: predicciones de estrategia.

Precalcula, por piloto y circuito, en qué vuelta convenía parar. El criterio no
es "cuándo compensa parar" —en F1 la parada es obligatoria porque hay que usar
dos compuestos— sino "dado que voy a parar una vez, en qué vuelta pierdo menos
tiempo en total". Se evalúan todas las vueltas candidatas y gana la de menor
costo acumulado.

Requiere el modelo entrenado por src/entrenamiento_modelo.py.
Salida: data/gold/predicciones.json

Uso:
    python src/predicciones.py

Variables de entorno:
    F1_YEARS  Temporadas a predecir. Deben coincidir con la era del modelo.
    F1_ERA    Nombre de la era, usado para localizar el .pkl del modelo.
"""

import json
import os
import pickle
from datetime import datetime, timezone

import numpy as np
import pandas as pd

SILVER_LAPS = "data/silver/laps"
GOLD_DIR = "data/gold"
OUTPUT = os.path.join(GOLD_DIR, "predicciones.json")

# Debe coincidir con la era que se usó al entrenar.
YEARS = [int(y) for y in os.environ.get("F1_YEARS", "2024,2025").split(",")]
ERA = os.environ.get("F1_ERA", "-".join(str(y) for y in YEARS))
MODEL_PATH = f"models/xgb_strategy_{ERA}.pkl"

PIT_LOSS_DEFAULT = 22.0
PIT_LOSS = {
    "monaco_grand_prix": 19.0,
    "singapore_grand_prix": 27.0,
    "british_grand_prix": 22.0,
    "italian_grand_prix": 21.0,
    "belgian_grand_prix": 20.0,
    "australian_grand_prix": 20.0,
    "abu_dhabi_grand_prix": 21.0,
}

COMPUESTOS = ["SOFT", "MEDIUM", "HARD"]
MAX_LAP = 80
MAX_TYRE = 60

# El compuesto que se monta en la parada, si no se sabe cuál usó de verdad.
ALTERNATIVO = {"SOFT": "HARD", "MEDIUM": "HARD", "HARD": "MEDIUM"}


def construir_grillas(model) -> dict:
    """
    Predice de una sola vez todas las combinaciones de compuesto, stint, vida
    del neumático y número de vuelta. Después se consulta por índice.

    Sin esto habría que llamar a predict() cientos de miles de veces: la
    optimización prueba cada vuelta candidata contra cada largo de stint.
    """
    cols = list(getattr(model, "feature_names_in_", []))
    grillas = {}

    for compound in COMPUESTOS:
        for stint in (1, 2):
            filas = []
            for tyre in range(MAX_TYRE):
                for lap in range(MAX_LAP):
                    row = {c: 0 for c in cols}
                    if "TyreLife" in row:
                        row["TyreLife"] = tyre
                    if "LapNumber" in row:
                        row["LapNumber"] = lap
                    if "Stint" in row:
                        row["Stint"] = stint
                    key = f"Compound_{compound}"
                    if key in row:
                        row[key] = 1
                    filas.append(row)

            X = pd.DataFrame(filas, columns=cols)
            pred = model.predict(X).reshape(MAX_TYRE, MAX_LAP)
            grillas[(compound, stint)] = pred

    return grillas


def costo_stint(grilla: np.ndarray, tyre_inicio: int, lap_desde: int, lap_hasta: int) -> float:
    """Suma el tiempo perdido en un tramo, con la goma envejeciendo vuelta a vuelta."""
    total = 0.0
    for k, lap in enumerate(range(lap_desde, lap_hasta + 1)):
        tyre = min(tyre_inicio + k, MAX_TYRE - 1)
        total += float(grilla[tyre, min(lap, MAX_LAP - 1)])
    return total


def optimizar_parada(grillas, comp1, comp2, lap_inicio, tyre_inicio, total_vueltas, pit_loss):
    """
    Prueba cada vuelta candidata como momento de parada y devuelve la que
    minimiza el tiempo total: lo perdido antes de parar, más el pit stop, más
    lo perdido después con la goma nueva.
    """
    g1 = grillas.get((comp1, 1))
    g2 = grillas.get((comp2, 2))
    if g1 is None or g2 is None:
        return None, None

    mejor_lap, mejor_costo = None, float("inf")

    # Se descartan los extremos: nadie para en la vuelta 2 ni a falta de dos.
    desde = lap_inicio + 3
    hasta = total_vueltas - 3
    if hasta <= desde:
        return None, None

    for p in range(desde, hasta + 1):
        costo = (
            costo_stint(g1, tyre_inicio, lap_inicio, p)
            + pit_loss
            + costo_stint(g2, 1, p + 1, total_vueltas)
        )
        if costo < mejor_costo:
            mejor_costo, mejor_lap = costo, p

    return mejor_lap, round(mejor_costo, 2)


def degradacion_por_vuelta(grillas, compound: str, lap: int) -> float:
    """Pendiente del ritmo entre una goma con 5 y con 20 vueltas de uso."""
    g = grillas.get((compound, 1))
    if g is None:
        return 0.0
    lap = min(lap, MAX_LAP - 1)
    return round((float(g[20, lap]) - float(g[5, lap])) / 15, 3)


def generar():
    print("INFO: cargando silver de vueltas...")
    laps = pd.read_parquet(SILVER_LAPS)

    laps["Year"] = laps["Year"].astype(int)
    laps = laps[laps["Year"].isin(YEARS)]

    for col in ("GrandPrix", "Driver"):
        laps[col] = laps[col].astype(str)

    print(f"INFO: era {ERA} · {len(laps)} vueltas")
    print(f"INFO: cargando modelo desde {MODEL_PATH}...")
    with open(MODEL_PATH, "rb") as f:
        model = pickle.load(f)

    print("INFO: precalculando grillas de predicción...")
    grillas = construir_grillas(model)

    resultados = []

    for (year, gp), df_gp in laps.groupby(["Year", "GrandPrix"], observed=True):
        pit_loss = PIT_LOSS.get(gp, PIT_LOSS_DEFAULT)
        total_vueltas = int(df_gp["LapNumber"].max())

        for driver, df_drv in df_gp.groupby("Driver", observed=True):
            stint1 = df_drv[df_drv["Stint"] == 1].sort_values("LapNumber")
            if stint1.empty:
                continue

            comp1 = str(stint1["Compound"].iloc[0])
            if comp1 not in COMPUESTOS:
                continue  # carrera de lluvia: la estrategia la manda el clima

            # Si el piloto llegó a parar, se usa el compuesto que montó de verdad.
            stint2 = df_drv[df_drv["Stint"] == 2]
            comp2 = str(stint2["Compound"].iloc[0]) if not stint2.empty else ALTERNATIVO[comp1]
            if comp2 not in COMPUESTOS:
                comp2 = ALTERNATIVO[comp1]

            lap_inicio = int(stint1["LapNumber"].min())
            tyre_inicio = int(stint1["TyreLife"].min())

            ventana, costo = optimizar_parada(
                grillas, comp1, comp2, lap_inicio, tyre_inicio, total_vueltas, pit_loss
            )

            real = None if stint2.empty else int(stint2["LapNumber"].min())

            resultados.append({
                "year": int(year),
                "gp": gp,
                "driver": driver,
                "compound_inicial": comp1,
                "compound_siguiente": comp2,
                "total_vueltas": total_vueltas,
                "pit_window": ventana,
                "pit_real": real,
                # El error contra la realidad: el número honesto del proyecto.
                "error_vueltas": None if (ventana is None or real is None) else abs(ventana - real),
                "degradacion_s_vuelta": degradacion_por_vuelta(grillas, comp1, lap_inicio),
                "costo_estimado_s": costo,
                "pit_loss_usado": pit_loss,
                "vueltas_stint1": int(len(stint1)),
            })

    os.makedirs(GOLD_DIR, exist_ok=True)

    # El front lee un único archivo: se conservan las predicciones de las otras
    # eras y se reemplazan solo las de esta.
    previas = []
    if os.path.exists(OUTPUT):
        try:
            with open(OUTPUT, encoding="utf-8") as f:
                previas = [
                    p for p in json.load(f).get("predicciones", [])
                    if p.get("year") not in YEARS
                ]
        except Exception:
            previas = []

    resultados = previas + resultados

    errores = [r["error_vueltas"] for r in resultados if r["error_vueltas"] is not None]
    mae = round(sum(errores) / len(errores), 2) if errores else None
    dentro_3 = sum(1 for e in errores if e <= 3)
    dentro_5 = sum(1 for e in errores if e <= 5)

    salida = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "predicciones_totales": len(resultados),
        "comparables": len(errores),
        "mae_vueltas": mae,
        "aciertos_3_vueltas": dentro_3,
        "aciertos_5_vueltas": dentro_5,
        "predicciones": resultados,
    }

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(salida, f, indent=2, ensure_ascii=False)

    print(f"SUCCESS: {len(resultados)} predicciones -> {OUTPUT}")
    if mae is not None:
        print(f"INFO: error promedio contra la parada real: {mae} vueltas")
        print(f"INFO: dentro de 3 vueltas: {dentro_3}/{len(errores)}"
              f" ({dentro_3 / len(errores) * 100:.0f}%)")
        print(f"INFO: dentro de 5 vueltas: {dentro_5}/{len(errores)}"
              f" ({dentro_5 / len(errores) * 100:.0f}%)")


if __name__ == "__main__":
    try:
        generar()
    except Exception as e:
        print(f"ERROR: falló la generación de predicciones. Detalle: {e}")
        raise
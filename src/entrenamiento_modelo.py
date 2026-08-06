"""
Entrenamiento del modelo de degradación de neumáticos.

Entrena un XGBoost sobre el silver de vueltas. No predice el tiempo de vuelta
absoluto sino cuánto se pierde respecto al mejor ritmo del piloto en esa
carrera. Predecir el absoluto obliga al modelo a saber en qué circuito está
—Monza gira en 80 s y Singapur en 100— y en un circuito nuevo eso es imposible.
El delta, en cambio, mide degradación pura y se transfiere entre pistas.

Salida: models/xgb_strategy_<era>.pkl y models/metrics_<era>.json

Uso:
    python src/entrenamiento_modelo.py

Variables de entorno:
    F1_YEARS    Temporadas a incluir, separadas por coma (por defecto 2024,2025).
    F1_ERA      Nombre de la era, usado en el nombre de archivo del modelo.
    F1_HOLDOUT  Circuito reservado para validación. Si se omite, se elige el de
                mayor volumen de vueltas.
"""

import json
import os
import pickle

import pandas as pd
import xgboost as xgb
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

SILVER_LAPS = "data/silver/laps"
MODEL_DIR = "models/"

# 2024 y 2025 comparten reglamento; 2026 estrena autos y motores. Entrenar un
# solo modelo con las tres mezcla dos comportamientos de degradación distintos,
# así que cada era tiene su modelo y sus métricas.
YEARS = [int(y) for y in os.environ.get("F1_YEARS", "2024,2025").split(",")]
ERA = os.environ.get("F1_ERA", "-".join(str(y) for y in YEARS))

MODEL_PATH = os.path.join(MODEL_DIR, f"xgb_strategy_{ERA}.pkl")
METRICS_PATH = os.path.join(MODEL_DIR, f"metrics_{ERA}.json")

# Solo compuestos de seco. En mojado los tiempos son varios segundos más lentos
# y esa señal, mucho más fuerte que la degradación, se come el modelo entero.
COMPUESTOS_SECO = ["SOFT", "MEDIUM", "HARD"]

FEATURES = ["TyreLife", "LapNumber", "Stint", "Compound"]
TARGET = "LapTimeDelta"

# Un F1 gana alrededor de 0,05 s por vuelta a medida que quema combustible.
# Es un efecto más grande que la degradación del neumático y va en dirección
# contraria: sin restarlo, tapa por completo la señal que interesa.
FUEL_EFFECT = 0.055


def limpiar(df: pd.DataFrame) -> pd.DataFrame:
    """
    Regla del 107% por circuito: descarta safety cars, vueltas de box y
    tráfico. Un umbral fijo en segundos no sirve con 24 pistas distintas.
    """
    df = df[df["LapTime"].notna()].copy()

    antes_lluvia = len(df)
    df = df[df["Compound"].isin(COMPUESTOS_SECO)]
    print(f"INFO: descartadas {antes_lluvia - len(df)} vueltas con neumático de lluvia")

    limite = df.groupby("GrandPrix", observed=True)["LapTime"].transform("median") * 1.07
    antes = len(df)
    df = df[df["LapTime"] <= limite]

    print(f"INFO: descartadas {antes - len(df)} vueltas por encima del 107%")
    return df


def preparar(df: pd.DataFrame) -> pd.DataFrame:
    """
    Dos correcciones antes de entrenar:

    1. Combustible: en la vuelta 1 el auto lleva el tanque lleno y es más lento
       por peso, no por la goma. Se le descuenta esa penalización, que es
       proporcional a las vueltas que le quedan por correr.
    2. Referencia por piloto y carrera: restar su mejor vuelta saca de la
       ecuación tanto el circuito como el ritmo del auto.

    Lo que queda es degradación, que es lo único transferible entre pistas.
    """
    total = df.groupby("GrandPrix", observed=True)["LapNumber"].transform("max")
    df["LapTimeFuelAdj"] = df["LapTime"] - FUEL_EFFECT * (total - df["LapNumber"])

    ref = df.groupby(["GrandPrix", "Driver"], observed=True)["LapTimeFuelAdj"].transform("min")
    df[TARGET] = df["LapTimeFuelAdj"] - ref
    return df


def train_and_export_model():
    print(f"INFO: leyendo silver desde {SILVER_LAPS}...")
    df = pd.read_parquet(SILVER_LAPS)

    df["Year"] = df["Year"].astype(int)
    df = df[df["Year"].isin(YEARS)]

    for col in ("GrandPrix", "Driver"):
        if col in df.columns:
            df[col] = df[col].astype(str)

    if df.empty:
        print(f"ERROR: no hay vueltas para {YEARS}")
        return

    circuitos = sorted(df["GrandPrix"].unique())
    print(f"INFO: era {ERA} · {len(df)} vueltas en {len(circuitos)} circuito(s)")

    df = preparar(limpiar(df))
    df_model = df[FEATURES + [TARGET, "GrandPrix"]].dropna()

    X_full = pd.get_dummies(df_model[FEATURES], columns=["Compound"], drop_first=False)
    y_full = df_model[TARGET]

    if len(circuitos) > 1:
        # Validación honesta: se prueba en un circuito que el modelo nunca vio.
        # Se elige el de mayor volumen de vueltas y no el último por orden
        # alfabético: si la fuente dejó una carrera incompleta, validar contra
        # ella da un número que no describe al modelo.
        holdout = os.environ.get("F1_HOLDOUT") or (
            df_model["GrandPrix"].value_counts().idxmax()
        )
        mask = df_model["GrandPrix"] == holdout
        X_train, X_test = X_full[~mask], X_full[mask]
        y_train, y_test = y_full[~mask], y_full[mask]
        print(f"INFO: validando contra el circuito completo '{holdout}' "
              f"({int((df_model['GrandPrix'] == holdout).sum())} vueltas)")
    else:
        X_train, X_test, y_train, y_test = train_test_split(
            X_full, y_full, test_size=0.2, random_state=42
        )
        holdout = None
        print("INFO: un solo circuito, split aleatorio (el MAE va a salir optimista)")

    print("INFO: entrenando XGBoost...")
    model = xgb.XGBRegressor(
        n_estimators=300,
        learning_rate=0.05,
        max_depth=5,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        objective="reg:squarederror",
    )
    model.fit(X_train, y_train)

    mae = mean_absolute_error(y_test, model.predict(X_test))

    # Comparación contra predecir siempre el promedio: si el modelo no le gana,
    # no está aprendiendo nada útil.
    baseline = mean_absolute_error(y_test, [y_train.mean()] * len(y_test))

    print(f"INFO: MAE {mae:.3f} s de delta  (baseline {baseline:.3f} s)")
    if mae < baseline:
        print(f"INFO: el modelo mejora un {(1 - mae / baseline) * 100:.1f}% sobre el promedio")
    else:
        print("ALERTA: el modelo NO le gana a predecir el promedio")

    importancias = dict(
        sorted(
            zip(X_full.columns, (float(v) for v in model.feature_importances_)),
            key=lambda kv: kv[1],
            reverse=True,
        )
    )

    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(model, f)

    with open(METRICS_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "era": ERA,
                "years": YEARS,
                "target": "delta contra la mejor vuelta del piloto en la carrera",
                "mae_segundos": round(float(mae), 3),
                "baseline_segundos": round(float(baseline), 3),
                "vueltas_entrenamiento": int(len(X_train)),
                "vueltas_validacion": int(len(X_test)),
                "circuitos": circuitos,
                "holdout": holdout,
                "features": list(X_full.columns),
                "importancias": {k: round(v, 4) for k, v in importancias.items()},
            },
            f,
            indent=2,
            ensure_ascii=False,
        )

    print(f"SUCCESS: modelo en {MODEL_PATH}, métricas en {METRICS_PATH}")
    print("INFO: features más importantes:", list(importancias)[:4])


if __name__ == "__main__":
    try:
        train_and_export_model()
    except Exception as e:
        print(f"ERROR: falló el pipeline de ML. Detalle: {e}")
        raise
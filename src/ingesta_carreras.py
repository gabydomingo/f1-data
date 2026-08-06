"""
Capa bronze: ingesta de datos crudos.

Extrae vueltas y telemetría de alta frecuencia vía FastF1 y las guarda en
Parquet sin transformar. La telemetría se arma vuelta por vuelta para conservar
LapNumber y una Distance que arranca en 0 en cada cruce de meta.

Uso:
    python src/ingesta_carreras.py

Variables de entorno:
    F1_YEAR       Temporada a ingestar (por defecto 2024).
    F1_GPS        Lista de Grandes Premios separados por coma. Si se omite, se
                  usa el calendario oficial de la temporada.
    F1_OVERWRITE  "1" para reprocesar carreras ya ingestadas.
"""

import json
import os
import fastf1
import pandas as pd

CACHE_DIR = "data/cache/"
RAW_DIR = "data/raw/"

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(RAW_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

# Columnas que sobreviven al bronze. Todo lo demás se descarta acá: cada
# columna de más se multiplica por ~800.000 filas por carrera.
#
# SessionTime es el reloj común de la sesión y es lo único que permite saber
# dónde estaba cada piloto en el mismo instante: sin eso se puede recorrer una
# vuelta, pero no comparar dos autos entre sí.
TELEMETRY_COLS = [
    "Driver", "Team", "LapNumber", "Compound",
    "SessionTime", "Distance", "Speed", "RPM", "nGear", "Throttle", "Brake", "DRS",
    "X", "Y",
    # Quién iba adelante y a qué distancia: es la materia prima del undercut.
    "DriverAhead", "DistanceToDriverAhead",
]


def slug(name: str) -> str:
    return name.replace(" ", "_").lower()


def build_telemetry(laps_df) -> pd.DataFrame:
    """
    Recorre vuelta por vuelta en lugar de pedir la telemetría del stint completo.
    Es más lento, pero es la única forma de saber a qué vuelta pertenece cada
    muestra y de que Distance se reinicie en cada cruce de meta.
    """
    frames = []

    for _, lap in laps_df.iterlaps():
        if pd.isna(lap["LapNumber"]):
            continue
        try:
            tel = lap.get_telemetry()  # incluye X/Y de posición y add_distance()
        except Exception as e:
            print(f"WARNING: sin telemetría para {lap['Driver']} vuelta {lap['LapNumber']} - {e}")
            continue

        if tel.empty:
            continue

        # SessionTime llega como timedelta; en segundos es comparable entre
        # pilotos y ocupa la mitad.
        if "SessionTime" in tel.columns:
            tel["SessionTime"] = tel["SessionTime"].dt.total_seconds()

        tel["Driver"] = str(lap["Driver"])
        tel["Team"] = str(lap["Team"])
        tel["LapNumber"] = int(lap["LapNumber"])
        tel["Compound"] = str(lap["Compound"])

        # Algunas vueltas no traen DRS según la sesión
        for col in TELEMETRY_COLS:
            if col not in tel.columns:
                tel[col] = 0

        frames.append(tel[TELEMETRY_COLS])

    if not frames:
        raise RuntimeError("No se pudo extraer telemetría de ninguna vuelta")

    df = pd.concat(frames, ignore_index=True)

    # Downcast: baja el peso del Parquet a menos de la mitad sin perder nada útil.
    df["Distance"] = df["Distance"].astype("float32")
    df["Speed"] = df["Speed"].astype("float32")
    df["RPM"] = df["RPM"].fillna(0).astype("int16")
    df["nGear"] = df["nGear"].fillna(0).astype("int8")
    df["Throttle"] = df["Throttle"].fillna(0).astype("int8")
    df["Brake"] = df["Brake"].fillna(False).astype("bool")
    df["DRS"] = df["DRS"].fillna(0).astype("int8")
    df["LapNumber"] = df["LapNumber"].astype("int16")
    df["X"] = df["X"].fillna(0).astype("int32")
    df["Y"] = df["Y"].fillna(0).astype("int32")
    df["SessionTime"] = df["SessionTime"].fillna(0).astype("float32")
    df["DriverAhead"] = df["DriverAhead"].fillna("").astype(str)
    df["DistanceToDriverAhead"] = (
        df["DistanceToDriverAhead"].fillna(0).clip(0, 9999).astype("float32")
    )

    return df


def extraer_eventos(session) -> pd.DataFrame:
    """
    Mensajes de dirección de carrera: banderas, safety car, investigaciones.

    Es lo que explica por qué un equipo paró antes de lo que convenía por
    degradación. Sin esto, esas paradas parecen decisiones inexplicables.
    """
    try:
        rcm = session.race_control_messages
    except Exception as e:
        print(f"WARNING: sin mensajes de carrera - {e}")
        return pd.DataFrame()

    if rcm is None or rcm.empty:
        return pd.DataFrame()

    ev = rcm.copy()

    for col in ("Time",):
        if col in ev.columns:
            ev[col] = ev[col].astype(str)

    for col in ("Category", "Message", "Status", "Flag", "Scope", "Sector", "RacingNumber"):
        if col in ev.columns:
            ev[col] = ev[col].fillna("").astype(str)

    if "Lap" in ev.columns:
        ev["Lap"] = pd.to_numeric(ev["Lap"], errors="coerce").fillna(0).astype("int16")

    return ev


def ingest_race_data(year: int, grand_prix: str, session_type: str = "R", overwrite: bool = False):
    gp = slug(grand_prix)
    out_dir = os.path.join(RAW_DIR, str(year), gp)
    os.makedirs(out_dir, exist_ok=True)

    path_laps = os.path.join(out_dir, f"{session_type}_laps.parquet")
    path_tel = os.path.join(out_dir, f"{session_type}_telemetry.parquet")

    # Ingesta incremental: bajar 24 carreras con telemetría son horas.
    # Si el GP ya está, se saltea salvo que se fuerce overwrite.
    if os.path.exists(path_tel) and not overwrite:
        print(f"SKIP: {gp} {year} ya ingestado")
        return

    print(f"\nINFO: --- Ingesta {grand_prix} {year} · sesión {session_type} ---")
    session = fastf1.get_session(year, grand_prix, session_type)
    # messages=True trae los mensajes de dirección de carrera, que es de donde
    # salen los safety cars y las banderas rojas.
    session.load(telemetry=True, weather=True, messages=True)

    laps_df = session.laps

    # FastF1 a veces descarta las vueltas de un piloto al parsear el timing.
    # Sin este chequeo, el piloto desaparece del silver sin dejar rastro.
    esperados = set(session.results["Abbreviation"].dropna().astype(str))
    presentes = set(laps_df["Driver"].astype(str).unique())
    faltantes = sorted(esperados - presentes)

    if faltantes:
        print(f"ALERTA: {gp} {year} sin vueltas para {faltantes}")

    with open(os.path.join(out_dir, f"{session_type}_report.json"), "w") as f:
        json.dump(
            {"gp": gp, "year": year, "pilotos": len(presentes), "faltantes": faltantes},
            f,
            indent=2,
        )

    # --- VUELTAS ---
    laps_export = laps_df.copy()
    for col in laps_export.select_dtypes(include=["timedelta64[ns]"]).columns:
        laps_export[col] = laps_export[col].dt.total_seconds()
    for col in laps_export.select_dtypes(include=["datetime", "datetimetz"]).columns:
        laps_export[col] = laps_export[col].astype(str)

    for col in ("Driver", "Team", "Compound"):
        laps_export[col] = laps_export[col].astype(str)

    laps_export["Year"] = year
    laps_export["GrandPrix"] = gp
    laps_export.to_parquet(path_laps, index=False)
    print(f"SUCCESS: vueltas -> {path_laps} ({len(laps_export)} filas)")

    # --- TELEMETRÍA ---
    print("INFO: Extrayendo telemetría vuelta por vuelta...")
    telemetry_df = build_telemetry(laps_df)
    telemetry_df["Year"] = year
    telemetry_df["GrandPrix"] = gp
    telemetry_df.to_parquet(path_tel, index=False, compression="snappy")
    print(f"SUCCESS: telemetría -> {path_tel} ({len(telemetry_df)} filas)")

    # --- EVENTOS DE CARRERA ---
    eventos = extraer_eventos(session)
    if not eventos.empty:
        eventos["Year"] = year
        eventos["GrandPrix"] = gp
        path_ev = os.path.join(out_dir, f"{session_type}_events.parquet")
        eventos.to_parquet(path_ev, index=False)

        banderas = eventos[eventos.get("Category", "") == "Flag"] if "Category" in eventos else eventos
        print(f"SUCCESS: eventos -> {path_ev} ({len(eventos)} mensajes, {len(banderas)} banderas)")


if __name__ == "__main__":
    TARGET_YEAR = int(os.environ.get("F1_YEAR", 2024))
    gps_env = os.environ.get("F1_GPS", "").strip()
    # F1_OVERWRITE=1 fuerza el reproceso; por defecto se saltea lo ya bajado,
    # que es lo que corresponde para el job semanal.
    overwrite = os.environ.get("F1_OVERWRITE", "0") == "1"

    if gps_env:
        CALENDARIO = [g.strip() for g in gps_env.split(",") if g.strip()]
    else:
        # El calendario oficial evita errores de tipeo y se adapta solo a cada
        # temporada. Se descartan las fechas que todavía no se corrieron.
        schedule = fastf1.get_event_schedule(TARGET_YEAR, include_testing=False)
        schedule = schedule[schedule["EventDate"] < pd.Timestamp.now()]
        CALENDARIO = schedule["EventName"].tolist()

    print(f"INFO: {len(CALENDARIO)} carreras a procesar en {TARGET_YEAR} "
          f"(overwrite={overwrite})")

    for gp in CALENDARIO:
        try:
            ingest_race_data(TARGET_YEAR, gp, overwrite=overwrite)
        except Exception as e:
            print(f"ERROR: falló la ingesta de {gp}. Detalle: {e}")
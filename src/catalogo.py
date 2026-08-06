"""
Capa gold: catálogo de carreras y pilotos.

Genera el índice que alimenta los filtros del dashboard. Cruza dos fuentes: el
calendario oficial de FastF1 —que sabe qué carreras existen y cuándo se corren,
incluidas las futuras— y el silver, que sabe cuáles ya están ingestadas. Así el
front puede mostrar la fecha de cada Gran Premio y avisar cuáles todavía no
tienen datos, en vez de simplemente no listarlos.

Salida: data/gold/catalogo.json

Uso:
    python src/catalogo.py
"""

import json
import os
from datetime import datetime, timezone

import fastf1
import pandas as pd

SILVER_LAPS = "data/silver/laps"
SILVER_TEL = "data/silver/telemetry"
CACHE_DIR = "data/cache/"
GOLD_DIR = "data/gold"
OUTPUT = os.path.join(GOLD_DIR, "catalogo.json")

# Temporadas que el dashboard ofrece, existan o no sus datos todavía.
TEMPORADAS = [2024, 2025, 2026]

# Excepciones donde quitar "grand prix" y capitalizar no alcanza.
NOMBRES = {
    "emilia_romagna_grand_prix": "Emilia-Romaña",
    "são_paulo_grand_prix": "São Paulo",
    "united_states_grand_prix": "Estados Unidos",
    "saudi_arabian_grand_prix": "Arabia Saudita",
    "mexico_city_grand_prix": "México",
    "abu_dhabi_grand_prix": "Abu Dhabi",
    "las_vegas_grand_prix": "Las Vegas",
    "british_grand_prix": "Gran Bretaña",
    "japanese_grand_prix": "Japón",
    "chinese_grand_prix": "China",
    "australian_grand_prix": "Australia",
    "bahrain_grand_prix": "Baréin",
    "spanish_grand_prix": "España",
    "austrian_grand_prix": "Austria",
    "hungarian_grand_prix": "Hungría",
    "belgian_grand_prix": "Bélgica",
    "dutch_grand_prix": "Países Bajos",
    "italian_grand_prix": "Italia",
    "azerbaijan_grand_prix": "Azerbaiyán",
    "singapore_grand_prix": "Singapur",
    "canadian_grand_prix": "Canadá",
    "miami_grand_prix": "Miami",
    "monaco_grand_prix": "Mónaco",
    "qatar_grand_prix": "Qatar",
    "barcelona_grand_prix": "Barcelona",
}


def slug(nombre: str) -> str:
    return nombre.replace(" ", "_").lower()


def nombre_lindo(s: str) -> str:
    if s in NOMBRES:
        return NOMBRES[s]
    return s.replace("_grand_prix", "").replace("_", " ").title()


def nombres_por_temporada(year: int, eventos: list) -> dict:
    """
    Mapea la abreviación de tres letras al nombre completo del piloto.

    Se recorren todas las carreras del año en vez de una sola porque la grilla
    cambia a mitad de temporada: quien entró tarde (Colapinto en 2024) no está
    en las primeras, y quien se fue no está en las últimas.

    La sesión se carga sin vueltas ni telemetría: alcanza con el listado de
    pilotos, y así sale del cache en menos de un segundo.
    """
    mapa = {}
    for nombre_evento in eventos:
        try:
            s = fastf1.get_session(year, nombre_evento, "R")
            s.load(laps=False, telemetry=False, weather=False, messages=False)
            for r in s.results.itertuples():
                abrev = str(getattr(r, "Abbreviation", "") or "")
                completo = str(getattr(r, "FullName", "") or "")
                if abrev and completo and abrev not in mapa:
                    mapa[abrev] = completo
        except Exception as e:
            print(f"WARNING: sin nombres para {nombre_evento} {year} - {e}")
    return mapa


def pilotos_con_telemetria(year: int, gp: str) -> list:
    """
    Pilotos que tienen telemetría cargada, leyendo las carpetas de partición.

    La lista NO sale del silver de vueltas: ahí se filtran las vueltas sin
    LapTime, así que un piloto que abandonó temprano desaparece de esa tabla
    aunque su telemetría esté guardada. El selector mostraría menos pilotos de
    los que la API puede servir.
    """
    base = os.path.join(SILVER_TEL, f"Year={year}", f"GrandPrix={gp}")
    if not os.path.isdir(base):
        return []
    return sorted(
        d.split("=", 1)[1] for d in os.listdir(base) if d.startswith("Driver=")
    )


def calidad_posicion(year: int, gp: str) -> float:
    """
    Proporción del recorrido en la que la posición acompaña al auto.

    Se compara, tramo a tramo, cuánto se movieron las coordenadas contra cuánto
    avanzó el auto. Cuando el timing pierde la posición, FastF1 repite la última
    conocida: el auto recorre cien metros y las coordenadas no se mueven. Esos
    tramos se cuentan como perdidos y el resultado es lo que queda.

    Dos métricas más simples no sirven acá. Contar coordenadas únicas penaliza a
    los circuitos cortos, donde repetir posiciones entre vueltas es normal. Y
    sumar el movimiento total tampoco: después de quedarse quieta, la posición
    pega un salto al punto correcto y la suma termina cerrando igual.
    """
    base = os.path.join(SILVER_TEL, f"Year={year}", f"GrandPrix={gp}")
    if not os.path.isdir(base):
        return 0.0

    pilotos = [d for d in os.listdir(base) if d.startswith("Driver=")]
    if not pilotos:
        return 0.0

    try:
        df = pd.read_parquet(
            os.path.join(base, pilotos[0]), columns=["LapNumber", "Distance", "X", "Y"]
        )
    except Exception:
        return 0.0

    if df.empty:
        return 0.0

    # Una vuelta del medio: la primera arranca desde la grilla.
    vueltas = sorted(df["LapNumber"].unique())
    v = df[df["LapNumber"] == vueltas[len(vueltas) // 2]].sort_values("Distance")

    if len(v) < 20:
        return 0.0

    arco = v["Distance"].diff()
    # X/Y vienen en décimas de metro
    cuerda = ((v["X"].diff() ** 2 + v["Y"].diff() ** 2) ** 0.5) / 10

    valido = arco > 0.5
    if not valido.any():
        return 0.0

    # La cuerda nunca supera al arco, pero sí puede ser bastante menor en una
    # curva cerrada. Por debajo de la mitad ya es posición estancada.
    estancado = valido & (cuerda < arco * 0.5)
    perdido = arco[estancado].sum() / arco[valido].sum()

    return round(float(1 - perdido), 3)


def equipos_por_carrera(laps: pd.DataFrame) -> dict:
    """Mapea (año, circuito, piloto) al equipo con el que corrió más vueltas."""
    fuera = {}
    for (year, gp), df in laps.groupby(["Year", "GrandPrix"], observed=True):
        pil = (
            df.groupby(["Driver", "Team"], observed=True)
            .size()
            .reset_index(name="n")
            .sort_values("n", ascending=False)
            .drop_duplicates("Driver")
        )
        for r in pil.itertuples():
            fuera[(int(year), gp, r.Driver)] = r.Team
    return fuera


def vueltas_por_carrera(laps: pd.DataFrame) -> dict:
    fuera = {}
    for (year, gp), df in laps.groupby(["Year", "GrandPrix"], observed=True):
        fuera[(int(year), gp)] = int(df["LapNumber"].max())
    return fuera


def generar():
    os.makedirs(CACHE_DIR, exist_ok=True)
    fastf1.Cache.enable_cache(CACHE_DIR)

    equipos = {}
    vueltas = {}
    equipo_por_anio = {}

    if os.path.isdir(SILVER_LAPS):
        print(f"INFO: leyendo {SILVER_LAPS}...")
        laps = pd.read_parquet(SILVER_LAPS)
        for col in ("Year", "GrandPrix", "Driver", "Team"):
            laps[col] = laps[col].astype(str)

        equipos = equipos_por_carrera(laps)
        vueltas = vueltas_por_carrera(laps)

        # Respaldo: si un piloto no tiene vueltas en esa carrera, se usa el
        # equipo con el que más corrió esa temporada.
        for (year, _gp, drv), team in equipos.items():
            equipo_por_anio.setdefault((year, drv), team)
    else:
        print("WARNING: no hay silver todavía, el catálogo va a salir vacío de datos")

    ahora = pd.Timestamp.now()
    circuitos = []

    for year in TEMPORADAS:
        try:
            schedule = fastf1.get_event_schedule(year, include_testing=False)
        except Exception as e:
            print(f"WARNING: sin calendario para {year} - {e}")
            continue

        # Los nombres se resuelven una vez por temporada, solo con las
        # carreras que efectivamente están ingestadas.
        eventos_con_datos = [
            ev.EventName
            for ev in schedule.itertuples()
            if pilotos_con_telemetria(year, slug(ev.EventName))
        ]
        nombres = nombres_por_temporada(year, eventos_con_datos) if eventos_con_datos else {}

        for ev in schedule.itertuples():
            s = slug(ev.EventName)
            codigos = pilotos_con_telemetria(year, s)
            fecha = pd.Timestamp(ev.EventDate)

            # Por debajo de 0,75 la posición avanza mucho menos que el auto:
            # el trazado saldría hecho pedazos.
            calidad = calidad_posicion(year, s) if codigos else 0.0

            circuitos.append({
                "year": year,
                "slug": s,
                "nombre": nombre_lindo(s),
                "ronda": int(ev.RoundNumber),
                "fecha": fecha.strftime("%Y-%m-%d"),
                "corrida": bool(fecha < ahora),
                # Puede haberse corrido y no estar ingestada todavía.
                "tiene_datos": bool(codigos),
                "posicion_calidad": calidad,
                "posicion_ok": calidad >= 0.75,
                "vueltas": vueltas.get((year, s)),
                "pilotos": [
                    {
                        "code": c,
                        "team": equipos.get((year, s, c))
                        or equipo_por_anio.get((year, c), "Sin equipo"),
                        "name": nombres.get(c, c),
                    }
                    for c in codigos
                ],
            })

        print(f"INFO: {year}: {len(schedule)} carreras en calendario, "
              f"{sum(1 for c in circuitos if c['year'] == year and c['tiene_datos'])} con datos")

    circuitos.sort(key=lambda c: (c["year"], c["ronda"]))
    equipos = sorted({p["team"] for c in circuitos for p in c["pilotos"]})

    salida = {
        "generado": datetime.now(timezone.utc).isoformat(),
        "years": TEMPORADAS,
        "equipos": equipos,
        "circuitos": circuitos,
    }

    os.makedirs(GOLD_DIR, exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(salida, f, indent=2, ensure_ascii=False)

    con_datos = sum(1 for c in circuitos if c["tiene_datos"])
    print(f"SUCCESS: {len(circuitos)} carreras ({con_datos} con datos) -> {OUTPUT}")


if __name__ == "__main__":
    try:
        generar()
    except Exception as e:
        print(f"ERROR: falló la generación del catálogo. Detalle: {e}")
        raise
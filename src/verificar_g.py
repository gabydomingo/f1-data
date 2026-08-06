"""
Diagnóstico del cálculo de fuerzas G.

Replica sobre los datos crudos del silver el mismo cálculo que hace el front,
para distinguir si los valores extremos vienen del método de estimación o de
saltos en la señal de posición del timing oficial.

Uso:
    python src/verificar_g.py [gp] [driver] [lap]

Ejemplo:
    python src/verificar_g.py monaco_grand_prix LEC 29
"""

import math
import sys

import pandas as pd

SILVER_TEL = "data/silver/telemetry"
A_METROS = 10  # las coordenadas del timing vienen en décimas de metro
BASE_M = 20
G = 9.81


def delta_angulo(a: float, b: float) -> float:
    d = a - b
    while d > math.pi:
        d -= 2 * math.pi
    while d < -math.pi:
        d += 2 * math.pi
    return d


def main():
    gp = sys.argv[1] if len(sys.argv) > 1 else "abu_dhabi_grand_prix"
    driver = sys.argv[2] if len(sys.argv) > 2 else "ALB"
    lap = int(sys.argv[3]) if len(sys.argv) > 3 else 29

    ruta = f"{SILVER_TEL}/Year=2024/GrandPrix={gp}/Driver={driver}"
    print(f"INFO: leyendo {ruta}")
    df = pd.read_parquet(ruta)
    df = df[df["LapNumber"] == lap].sort_values("Distance").reset_index(drop=True)

    if df.empty:
        print("ERROR: no hay datos para esa combinación")
        return

    print(f"\npuntos: {len(df)}")
    print(f"distancia: {df['Distance'].min():.0f} a {df['Distance'].max():.0f} m")
    print(f"velocidad: {df['Speed'].min():.0f} a {df['Speed'].max():.0f} km/h")

    # ¿Cada cuántos metros llega una muestra?
    seps = df["Distance"].diff().dropna()
    print(f"\nseparación entre muestras: mediana {seps.median():.2f} m, "
          f"min {seps.min():.2f}, max {seps.max():.2f}")

    # ¿La posición es coherente con la distancia recorrida? La línea recta
    # entre dos muestras no puede superar el arco recorrido sobre la pista.
    saltos = 0
    for i in range(1, len(df)):
        cuerda = math.hypot(
            df.X[i] - df.X[i - 1], df.Y[i] - df.Y[i - 1]
        ) / A_METROS
        arco = df.Distance[i] - df.Distance[i - 1]
        if arco > 0.5 and cuerda > arco * 1.3:
            saltos += 1
    print(f"muestras con posición incoherente: {saltos} de {len(df)}")

    # Mismo cálculo que hace el front
    def vecino(i, dir_):
        j = i
        while 0 <= j + dir_ < len(df):
            j += dir_
            if abs(df.Distance[j] - df.Distance[i]) >= BASE_M:
                break
        return j

    def calcular(con_filtro: bool):
        filas = []
        for i in range(1, len(df) - 1):
            ia, ib = vecino(i, -1), vecino(i, 1)
            if ia == i or ib == i:
                continue

            v = df.Speed[i] / 3.6
            r1 = math.atan2(df.Y[i] - df.Y[ia], df.X[i] - df.X[ia])
            r2 = math.atan2(df.Y[ib] - df.Y[i], df.X[ib] - df.X[i])
            ds = (df.Distance[ib] - df.Distance[ia]) / 2

            if ds <= 1:
                continue

            if con_filtro:
                # La línea recta entre dos muestras no puede superar el arco
                # recorrido sobre la pista: si lo hace, hubo salto de señal.
                cuerda_e = math.hypot(df.X[i] - df.X[ia], df.Y[i] - df.Y[ia]) / A_METROS
                cuerda_s = math.hypot(df.X[ib] - df.X[i], df.Y[ib] - df.Y[i]) / A_METROS
                arco_e = df.Distance[i] - df.Distance[ia]
                arco_s = df.Distance[ib] - df.Distance[i]
                if not (arco_e > 1 and arco_s > 1
                        and cuerda_e <= arco_e * 1.15 and cuerda_s <= arco_s * 1.15):
                    filas.append({"distance": df.Distance[i], "speed": df.Speed[i],
                                  "radio_m": float("inf"), "g_lat": 0.0})
                    continue

            k = abs(delta_angulo(r2, r1)) / ds
            filas.append({
                "distance": df.Distance[i],
                "speed": df.Speed[i],
                "radio_m": (1 / k) if k > 1e-6 else float("inf"),
                "g_lat": (v * v * k) / G,
            })
        return pd.DataFrame(filas)

    crudo = calcular(False)
    res = calcular(True)

    # La mediana móvil descarta el pico aislado en vez de repartirlo.
    res["g_lat"] = res["g_lat"].rolling(7, center=True, min_periods=1).median()

    print(f"\nSIN filtro: p90 {crudo.g_lat.quantile(0.9):.2f}, máx {crudo.g_lat.max():.2f}")
    print(f"CON filtro: p90 {res.g_lat.quantile(0.9):.2f}, máx {res.g_lat.max():.2f}")
    print(f"\nG lateral: mediana {res.g_lat.median():.2f}, "
          f"p90 {res.g_lat.quantile(0.9):.2f}, máx {res.g_lat.max():.2f}")

    # En el punto más rápido de la vuelta el auto va casi derecho: ahí la G
    # lateral tiene que ser baja. Si no lo es, el cálculo está inflado.
    veloz = res.loc[res.speed.idxmax()]
    print(f"\nen el punto más rápido ({veloz.speed:.0f} km/h): "
          f"{veloz.g_lat:.2f} G, radio {veloz.radio_m:.0f} m")
    print("  (esperado: G baja y radio grande, son cientos de metros en recta)")

    lento = res.loc[res.speed.idxmin()]
    print(f"en el punto más lento ({lento.speed:.0f} km/h): "
          f"{lento.g_lat:.2f} G, radio {lento.radio_m:.0f} m")

    print("\nlos 5 puntos con más G:")
    print(res.nlargest(5, "g_lat").to_string(index=False,
          float_format=lambda x: f"{x:.1f}"))


if __name__ == "__main__":
    main()
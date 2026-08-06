import type { TelemetryPoint, TelemetryPointExt } from "./types";

const G = 9.81;

// Base mínima para medir curvatura. Algunas muestras consecutivas están a
// medio metro y las coordenadas tienen resolución de 10 cm: con tres puntos
// tan juntos, el radio calculado es puro ruido y las G se disparan.
const BASE_M = 20;

// Las coordenadas del timing oficial vienen en décimas de metro.
const A_METROS = 10;

/**
 * Mediana móvil. Se usa mediana y no promedio porque un solo punto con salto
 * de señal produce un valor enorme, y el promedio lo reparte entre todos sus
 * vecinos en vez de descartarlo.
 */
function suavizar(valores: number[], ventana = 7): number[] {
  const mitad = Math.floor(ventana / 2);
  return valores.map((_, i) => {
    const trozo: number[] = [];
    for (let k = i - mitad; k <= i + mitad; k++) {
      if (k >= 0 && k < valores.length) trozo.push(valores[k]);
    }
    if (trozo.length === 0) return 0;
    trozo.sort((x, y) => x - y);
    return trozo[Math.floor(trozo.length / 2)];
  });
}

/**
 * Diferencia entre dos ángulos, normalizada a [-π, π].
 *
 * Sin esto, pasar de 179° a -179° se lee como un giro de 358° en vez de 2°,
 * y el auto aparece doblando violentamente en plena recta.
 */
function deltaAngulo(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Agrega fuerzas G a cada punto. No vienen en la telemetría oficial: se
 * calculan a partir de la trayectoria (lateral) y del cambio de velocidad
 * respecto a la distancia (longitudinal).
 */
export function enriquecer(puntos: TelemetryPoint[]): TelemetryPointExt[] {
  const n = puntos.length;
  if (n < 3) return puntos.map((p) => ({ ...p, gLat: 0, gLon: 0 }));

  const gLatCrudo = new Array<number>(n).fill(0);
  const gLonCrudo = new Array<number>(n).fill(0);

  /** Índice separado al menos BASE_M metros del punto i, en la dirección dada. */
  const vecino = (i: number, dir: 1 | -1) => {
    let j = i;
    while (j + dir >= 0 && j + dir < n) {
      j += dir;
      if (Math.abs(puntos[j].distance - puntos[i].distance) >= BASE_M) break;
    }
    return j;
  };

  for (let i = 1; i < n - 1; i++) {
    const ia = vecino(i, -1);
    const ib = vecino(i, 1);
    if (ia === i || ib === i) continue;

    const prev = puntos[ia];
    const act = puntos[i];
    const next = puntos[ib];

    const v = act.speed / 3.6; // km/h -> m/s

    // Curvatura por cambio de rumbo: se compara la dirección del tramo que
    // entra al punto con la del que sale. Es mucho más estable que ajustar
    // una circunferencia a tres muestras con ruido de posición.
    const rumboEntra = Math.atan2(act.y - prev.y, act.x - prev.x);
    const rumboSale = Math.atan2(next.y - act.y, next.x - act.x);

    // Control de coherencia: la distancia en línea recta entre dos muestras
    // no puede superar lo que el auto recorrió sobre la pista. Cuando el
    // timing pierde señal la posición salta, el rumbo gira casi 180° y la G
    // se dispara. Esos tramos se descartan en vez de propagar el disparate.
    const cuerdaEntra = Math.hypot(act.x - prev.x, act.y - prev.y) / A_METROS;
    const cuerdaSale = Math.hypot(next.x - act.x, next.y - act.y) / A_METROS;
    const arcoEntra = act.distance - prev.distance;
    const arcoSale = next.distance - act.distance;

    const coherente =
      arcoEntra > 1 &&
      arcoSale > 1 &&
      cuerdaEntra <= arcoEntra * 1.15 &&
      cuerdaSale <= arcoSale * 1.15;

    const ds = (next.distance - prev.distance) / 2;
    if (coherente && ds > 1) {
      const k = Math.abs(deltaAngulo(rumboSale, rumboEntra)) / ds; // 1/metro
      gLatCrudo[i] = (v * v * k) / G;
    }

    // Longitudinal: a = v · dv/ds. No hay marca de tiempo entre muestras,
    // pero sí distancia, y la regla de la cadena permite el cambio.
    const total = next.distance - prev.distance;
    if (total > 1) {
      const dv = (next.speed - prev.speed) / 3.6;
      gLonCrudo[i] = (v * (dv / total)) / G;
    }
  }

  const gLat = suavizar(gLatCrudo, 7);
  const gLon = suavizar(gLonCrudo, 7);

  // Techo defensivo: el récord de aceleración lateral en F1 ronda los 5,5 G
  // y se da en curvas muy rápidas. Por encima de eso es ruido, no física.
  const clamp = (x: number, min: number, max: number) => Math.min(Math.max(x, min), max);

  return puntos.map((p, i) => ({
    ...p,
    gLat: Number(clamp(gLat[i], 0, 5.2).toFixed(2)),
    gLon: Number(clamp(gLon[i], -6, 2.5).toFixed(2)),
  }));
}
// Espejo exacto de lo que devuelve /api/telemetry.
export type TelemetryPoint = {
  lap: number;
  distance: number;
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  drs: number;
  x: number;
  y: number;
  /** Compuesto de neumático de esa vuelta: SOFT, MEDIUM, HARD... */
  compound?: string;
};

/** Punto con las fuerzas G derivadas en el cliente (ver lib/derive.ts). */
export type TelemetryPointExt = TelemetryPoint & {
  /** Aceleración lateral en G, calculada del radio de la trayectoria */
  gLat: number;
  /** Longitudinal en G: negativa al frenar, positiva al acelerar */
  gLon: number;
};

// Extremos de X/Y calculados en el server para armar el viewBox del SVG.
export type Bounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export type TelemetryResponse = {
  status: "success" | "error";
  year?: number;
  gp?: string;
  driver?: string;
  lap?: number | null;
  laps_disponibles?: number[];
  points?: number;
  downsampled?: boolean;
  bounds?: Bounds;
  telemetry?: TelemetryPoint[];
  message?: string;
};

export const F1_RED = "#E10600";

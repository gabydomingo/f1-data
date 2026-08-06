"use client";

import { useEffect, useRef, useState } from "react";
import type { Bounds, TelemetryPoint, TelemetryResponse } from "../lib/types";

type Params = {
  gp: string | null;
  driver: string | null;
  lap: number | null;
  year?: number;
};

type State = {
  data: TelemetryPoint[];
  bounds: Bounds | null;
  lapsDisponibles: number[];
  /** Vuelta que terminó devolviendo la API: puede no ser la pedida. */
  lapActual: number | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: State = {
  data: [],
  bounds: null,
  lapsDisponibles: [],
  lapActual: null,
  loading: false,
  error: null,
};

export function useTelemetry({ gp, driver, lap, year = 2024 }: Params): State {
  const [state, setState] = useState<State>({ ...EMPTY, loading: true });

  // Última combinación efectivamente servida. Cuando se pide sin vuelta, la
  // API elige una y el front la adopta; sin esta guarda, ese cambio dispara
  // un segundo fetch que trae exactamente los mismos datos.
  const servido = useRef<string | null>(null);

  useEffect(() => {
    if (!gp || !driver) {
      setState({ ...EMPTY, loading: true });
      return;
    }

    if (lap !== null && servido.current === `${year}|${gp}|${driver}|${lap}`) return;

    const controller = new AbortController();
    let cancelado = false;

    async function run() {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      // URLSearchParams escapa los slugs con acento (são_paulo_grand_prix),
      // que de otro modo rompen la URL.
      const params = new URLSearchParams({
        year: String(year),
        gp: gp as string,
        driver: driver as string,
      });
      if (lap !== null) params.set("lap", String(lap));

      try {
        const res = await fetch(`/api/telemetry?${params}`, { signal: controller.signal });
        const json: TelemetryResponse = await res.json();

        if (!res.ok || json.status !== "success" || !json.telemetry) {
          throw new Error(json.message ?? `La API respondió ${res.status}`);
        }
        if (cancelado) return;

        servido.current = `${year}|${gp}|${driver}|${json.lap ?? ""}`;

        setState({
          data: json.telemetry,
          bounds: json.bounds ?? null,
          lapsDisponibles: json.laps_disponibles ?? [],
          lapActual: json.lap ?? null,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelado || (err as Error).name === "AbortError") return;
        setState({ ...EMPTY, loading: false, error: (err as Error).message });
      }
    }

    run();

    // Cambiar de circuito, piloto o vuelta rápido dispara varios fetch: se
    // aborta el anterior para que una respuesta vieja no pise a la nueva.
    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [gp, driver, lap, year]);

  return state;
}
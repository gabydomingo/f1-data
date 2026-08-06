"use client";

import { useEffect, useState } from "react";

export type Prediccion = {
  year: number;
  gp: string;
  driver: string;
  compound_inicial: string;
  compound_siguiente: string;
  total_vueltas: number;
  pit_window: number | null;
  pit_real: number | null;
  error_vueltas: number | null;
  degradacion_s_vuelta: number;
};

export type ResumenPredicciones = {
  comparables?: number;
  mae_vueltas?: number | null;
  aciertos_5_vueltas?: number;
};

export type MetricasModelo = {
  mae_segundos?: number;
  baseline_segundos?: number;
  holdout?: string | null;
  circuitos?: string[];
};

type State = {
  prediccion: Prediccion | null;
  resumen: ResumenPredicciones | null;
  modelo: MetricasModelo | null;
  error: string | null;
};

export function useStrategy(year: number, gp: string | null, driver: string | null): State {
  const [state, setState] = useState<State>({
    prediccion: null,
    resumen: null,
    modelo: null,
    error: null,
  });

  useEffect(() => {
    if (!gp || !driver) return;

    const controller = new AbortController();
    let cancelado = false;

    const params = new URLSearchParams({ year: String(year), gp, driver });

    fetch(`/api/strategy?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.message ?? `La API respondió ${res.status}`);
        return json;
      })
      .then((json) => {
        if (cancelado) return;
        setState({
          prediccion: json.prediccion ?? null,
          resumen: json.resumen ?? null,
          modelo: json.modelo ?? null,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelado || err.name === "AbortError") return;
        setState({ prediccion: null, resumen: null, modelo: null, error: err.message });
      });

    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [year, gp, driver]);

  return state;
}

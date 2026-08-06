"use client";

import { useEffect, useMemo, useState } from "react";

export type PilotoCatalogo = { code: string; team: string; name: string };

/** "Alexander Albon" -> "Albon". Los nombres completos no entran en el selector. */
export function apellido(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  return partes.length > 1 ? partes.slice(1).join(" ") : nombre;
}

export type CircuitoCatalogo = {
  year: number;
  slug: string;
  nombre: string;
  ronda: number;
  /** ISO corto: 2024-07-07 */
  fecha: string;
  /** Ya se disputó según el calendario oficial */
  corrida: boolean;
  /** Está ingestada en el data lake (puede haberse corrido y faltar) */
  tiene_datos: boolean;
  /** Proporción de coordenadas distintas: baja = posición repetida o rota */
  posicion_calidad: number;
  /** Si el mapa de pista es dibujable con estos datos */
  posicion_ok: boolean;
  vueltas: number | null;
  pilotos: PilotoCatalogo[];
};

export type Catalogo = {
  years: number[];
  equipos: string[];
  circuitos: CircuitoCatalogo[];
};

export function fechaCorta(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

export function useCatalogo() {
  const [data, setData] = useState<Catalogo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;

    fetch("/api/catalog")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.message ?? `La API respondió ${res.status}`);
        return json as Catalogo;
      })
      .then((json) => {
        if (!cancelado) setData(json);
      })
      .catch((err: Error) => {
        if (!cancelado) setError(err.message);
      });

    return () => {
      cancelado = true;
    };
  }, []);

  return { catalogo: data, error };
}

/**
 * Agrupa los pilotos de un circuito por escudería, para el <optgroup> del
 * selector. La lista sale del catálogo, así que se adapta sola a cada
 * temporada sin tocar código.
 */
export function usePilotosPorEquipo(circuito: CircuitoCatalogo | undefined) {
  return useMemo(() => {
    if (!circuito) return [] as { team: string; pilotos: PilotoCatalogo[] }[];

    const mapa = new Map<string, PilotoCatalogo[]>();
    for (const p of circuito.pilotos) {
      if (!mapa.has(p.team)) mapa.set(p.team, []);
      mapa.get(p.team)!.push(p);
    }

    return [...mapa.entries()]
      .map(([team, pilotos]) => ({ team, pilotos }))
      .sort((a, b) => a.team.localeCompare(b.team));
  }, [circuito]);
}

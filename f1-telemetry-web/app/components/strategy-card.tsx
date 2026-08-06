"use client";

import { F1_RED } from "../lib/types";
import type { MetricasModelo, Prediccion, ResumenPredicciones } from "../hooks/use-strategy";

const COLOR_COMPUESTO: Record<string, string> = {
  SOFT: "#E10600",
  MEDIUM: "#f5c518",
  HARD: "#e5e5e5",
  INTERMEDIATE: "#22c55e",
  WET: "#3b82f6",
};

type Props = {
  prediccion: Prediccion | null;
  resumen: ResumenPredicciones | null;
  modelo: MetricasModelo | null;
  error: string | null;
};

export default function StrategyCard({ prediccion, resumen, modelo, error }: Props) {
  if (error) {
    return (
      <div className="border-t border-neutral-800 p-4">
        <Titulo />
        <p className="mt-2 text-[11px] text-[#E10600]">{error}</p>
      </div>
    );
  }

  if (!prediccion) {
    return (
      <div className="border-t border-neutral-800 p-4">
        <Titulo />
        <p className="mt-2 text-[11px] text-neutral-500">
          Sin predicción para este piloto. El modelo trabaja con carreras en seco: si esta fue
          con lluvia, la estrategia la manda el clima y no la degradación.
        </p>
      </div>
    );
  }

  const { pit_window, pit_real, total_vueltas, degradacion_s_vuelta } = prediccion;
  const pct = (v: number) => Math.min(Math.max((v / total_vueltas) * 100, 0), 100);
  const diferencia =
    pit_window !== null && pit_real !== null ? pit_window - pit_real : null;

  return (
    <div className="border-t border-neutral-800 p-4">
      <Titulo />

      <div className="mt-3 flex items-baseline gap-4">
        <Dato label="ÓPTIMO DEL MODELO" valor={pit_window ?? "—"} color="#e5e5e5" />
        <Dato label="PARADA REAL" valor={pit_real ?? "—"} color={F1_RED} />
        {diferencia !== null && (
          <span className="ml-auto text-[10px] text-neutral-500">
            {diferencia > 0 ? `${diferencia} vueltas tarde` : diferencia < 0 ? `${-diferencia} antes` : "exacto"}
          </span>
        )}
      </div>

      {/* Línea de tiempo de la carrera con las dos vueltas marcadas */}
      <div className="relative mt-3 h-6">
        <div className="absolute inset-x-0 top-2.5 h-1 bg-neutral-800" />
        {pit_window !== null && (
          <Marca pos={pct(pit_window)} color="#e5e5e5" />
        )}
        {pit_real !== null && <Marca pos={pct(pit_real)} color={F1_RED} />}
        <span className="absolute -bottom-1 left-0 text-[9px] text-neutral-600">v1</span>
        <span className="absolute -bottom-1 right-0 text-[9px] text-neutral-600">
          v{total_vueltas}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3 text-[10px] text-neutral-500">
        <Neumatico compuesto={prediccion.compound_inicial} />
        <span>→</span>
        <Neumatico compuesto={prediccion.compound_siguiente} />
        <span className="ml-auto">
          {degradacion_s_vuelta > 0.02 ? (
            <>
              degradación <span className="text-neutral-300">{degradacion_s_vuelta}s</span>/vuelta
            </>
          ) : (
            // Un valor nulo o negativo no es un error de signo: en esa carrera
            // el desgaste quedó por debajo del ruido del modelo.
            <span className="text-neutral-600">sin degradación medible</span>
          )}
        </span>
      </div>

      {degradacion_s_vuelta <= 0.02 && (
        <p className="mt-3 text-[10px] leading-relaxed text-amber-600/80">
          En esta carrera el modelo no detecta pérdida de ritmo por desgaste, así que la
          ventana que propone no es confiable.
        </p>
      )}

      <p className="mt-3 border-t border-neutral-800 pt-2 text-[10px] leading-relaxed text-neutral-500">
        {/* El sesgo es sistemático y tiene explicación: vale más contarlo que
            esconderlo detrás de un número que no se sostiene. */}
        El modelo busca la parada que minimiza el tiempo total. Los equipos suelen adelantarla
        para ganar posiciones con goma nueva, o la deciden por un coche de seguridad.
        {modelo?.mae_segundos !== undefined && (
          <>
            {" "}Error del modelo de degradación: {modelo.mae_segundos}s por vuelta
            {modelo.baseline_segundos
              ? ` (baseline ${modelo.baseline_segundos}s)`
              : ""}
            .
          </>
        )}
        {resumen?.comparables ? ` Sobre ${resumen.comparables} paradas analizadas.` : ""}
      </p>
    </div>
  );
}

function Titulo() {
  return <p className="text-[11px] tracking-widest text-[#E10600]">C · ESTRATEGIA</p>;
}

function Dato({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div>
      <p className="text-[9px] tracking-widest text-neutral-500">{label}</p>
      <p className="text-lg leading-tight" style={{ color }}>
        {typeof valor === "number" ? `v${valor}` : valor}
      </p>
    </div>
  );
}

function Marca({ pos, color }: { pos: number; color: string }) {
  return (
    <span
      className="absolute top-0 h-6 w-0.5"
      style={{ left: `${pos}%`, background: color }}
    />
  );
}

function Neumatico({ compuesto }: { compuesto: string }) {
  const color = COLOR_COMPUESTO[compuesto] ?? "#737373";
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="h-2.5 w-2.5 rounded-full border-2"
        style={{ borderColor: color }}
      />
      {compuesto.toLowerCase()}
    </span>
  );
}

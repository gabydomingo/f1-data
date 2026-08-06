"use client";

import { memo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { F1_RED, type TelemetryPoint } from "../lib/types";

// Los márgenes se comparten con el overlay del cursor: si cambian acá,
// la línea roja se desalinea del área de ploteo.
const MARGIN = { top: 12, right: 44, bottom: 22, left: 44 };

type Props = {
  data: TelemetryPoint[];
  playhead: number;
  onScrub: (index: number) => void;
};

// El chart se memoiza contra `data` solamente. El playhead se dibuja aparte,
// como un div absoluto, así mover el cursor no re-renderiza los 700 puntos.
const Chart = memo(function Chart({
  data,
  onScrub,
}: {
  data: TelemetryPoint[];
  onScrub: (index: number) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={MARGIN}
        onMouseMove={(state) => {
          if (typeof state?.activeTooltipIndex === "number") {
            onScrub(state.activeTooltipIndex);
          }
        }}
      >
        <CartesianGrid stroke="#262626" strokeDasharray="2 4" vertical={false} />

        <XAxis
          dataKey="distance"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v: number) => `${Math.round(v)}m`}
          tick={{ fill: "#737373", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />

        {/* Eje izquierdo: velocidad en km/h */}
        <YAxis
          yAxisId="speed"
          domain={[0, "dataMax + 20"]}
          tick={{ fill: "#737373", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />

        {/* Eje derecho: acelerador 0-100% */}
        <YAxis
          yAxisId="throttle"
          orientation="right"
          domain={[0, 100]}
          tick={{ fill: "#525252", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />

        {/* Tooltip vacío: sólo mantiene activo el cálculo de activeTooltipIndex */}
        <Tooltip content={() => null} cursor={false} isAnimationActive={false} />

        <Line
          yAxisId="speed"
          type="monotone"
          dataKey="speed"
          stroke={F1_RED}
          strokeWidth={1.6}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          yAxisId="throttle"
          type="monotone"
          dataKey="throttle"
          stroke="#e5e5e5"
          strokeWidth={1}
          strokeDasharray="3 3"
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
});

export default function TelemetryChart({ data, playhead, onScrub }: Props) {
  const first = data[0]?.distance ?? 0;
  const last = data[data.length - 1]?.distance ?? 1;
  const current = data[playhead]?.distance ?? first;
  const ratio = last === first ? 0 : (current - first) / (last - first);

  return (
    <div className="relative h-full min-h-0 w-full">
      <Chart data={data} onScrub={onScrub} />

      {data.length > 0 && (
        <div
          className="pointer-events-none absolute w-px bg-[#E10600]/70"
          style={{
            top: MARGIN.top,
            bottom: MARGIN.bottom,
            left: `calc(${MARGIN.left}px + (100% - ${MARGIN.left + MARGIN.right}px) * ${ratio})`,
          }}
        >
          <span className="absolute -top-1 left-1 whitespace-nowrap font-mono text-[10px] text-[#E10600]">
            {Math.round(current)}m
          </span>
        </div>
      )}
    </div>
  );
}

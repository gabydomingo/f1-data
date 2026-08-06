"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { F1_RED, type Bounds, type TelemetryPointExt } from "../lib/types";

const VIEW_W = 400;
const VIEW_H = 320;
const PAD = 26;

// Tolerancia del corte por pérdida de señal. El criterio no puede ser una
// distancia fija en unidades del SVG: un circuito corto se dibuja más grande y
// sus saltos normales serían mayores que los de uno largo. Se compara contra
// lo que el auto recorrió de verdad entre las dos muestras.
const TOLERANCIA_SALTO = 1.8;

type Props = {
  points: TelemetryPointExt[];
  bounds: Bounds | null;
  playhead: number;
  onScrub: (index: number) => void;
  /** Para el color del marcador y del cartel */
  color?: string;
  etiqueta?: string;
};

type P = { x: number; y: number; brake: number; distance: number; escala: number };

/**
 * Catmull-Rom convertido a curvas de Bézier. Une los puntos con arcos en vez
 * de rectas, que es lo que hace que un circuito parezca un circuito y no un
 * polígono, sobre todo con zoom.
 */
function suavizar(pts: P[]): string {
  if (pts.length < 2) return "";

  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;

    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }

  return d;
}

export default function TrackMap({
  points,
  bounds,
  playhead,
  onScrub,
  color = F1_RED,
  etiqueta,
}: Props) {
  const gRef = useRef<SVGGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const arrastre = useRef<{ x: number; y: number } | null>(null);

  const projected = useMemo(() => {
    if (!bounds || points.length === 0) return null;

    // Cada circuito viene con la orientación del timing oficial. Se prueban
    // dos giros y gana el que permite dibujar más grande.
    const candidatos = [0, 90].map((deg) => {
      const pts = points.map((p) => (deg === 0 ? { x: p.x, y: p.y } : { x: p.y, y: -p.x }));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const spanX = Math.max(...xs) - minX || 1;
      const spanY = Math.max(...ys) - minY || 1;
      const scale = Math.min((VIEW_W - PAD * 2) / spanX, (VIEW_H - PAD * 2) / spanY);
      return { pts, minX, minY, spanX, spanY, scale };
    });

    const best = candidatos[0].scale >= candidatos[1].scale ? candidatos[0] : candidatos[1];
    const offsetX = (VIEW_W - best.spanX * best.scale) / 2;
    const offsetY = (VIEW_H - best.spanY * best.scale) / 2;

    // El eje Y del SVG crece hacia abajo y el de la pista hacia arriba.
    // La escala viaja con los puntos: hace falta para saber cuánto "debería"
    // medir un tramo en pantalla según los metros recorridos.
    const escala = best.scale * 10; // las coordenadas vienen en décimas de metro

    return best.pts.map((p, i) => ({
      x: offsetX + (p.x - best.minX) * best.scale,
      y: VIEW_H - (offsetY + (p.y - best.minY) * best.scale),
      brake: points[i].brake,
      distance: points[i].distance,
      escala,
    }));
  }, [points, bounds]);

  const paths = useMemo(() => {
    if (!projected) return { tramos: [] as string[], frenadas: [] as string[] };

    // Se corta el trazo donde hay pérdida de señal: sin esto aparecen rectas
    // atravesando el circuito de lado a lado.
    const tramos: string[] = [];
    const frenadas: string[] = [];

    let actual: P[] = [];
    let frenando: P[] = [];

    const cerrar = () => {
      if (actual.length > 1) tramos.push(suavizar(actual));
      actual = [];
    };
    const cerrarFreno = () => {
      if (frenando.length > 1) frenadas.push(suavizar(frenando));
      frenando = [];
    };

    projected.forEach((p, i) => {
      const prev = projected[i - 1];
      if (prev) {
        const cuerda = Math.hypot(p.x - prev.x, p.y - prev.y);
        // Cuánto debería medir el tramo en pantalla según los metros recorridos.
        const esperado = Math.max((p.distance - prev.distance) * p.escala, 0);
        if (cuerda > Math.max(esperado * TOLERANCIA_SALTO, 8)) {
          cerrar();
          cerrarFreno();
        }
      }

      actual.push(p);

      if (p.brake) frenando.push(p);
      else cerrarFreno();
    });

    cerrar();
    cerrarFreno();

    return { tramos, frenadas };
  }, [projected]);

  // Cada circuito nuevo vuelve al encuadre completo.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [bounds]);

  const aCoordenadas = useCallback((clientX: number, clientY: number) => {
    const g = gRef.current;
    const ctm = g?.getScreenCTM();
    if (!ctm) return null;
    // El CTM del <g> incluye zoom y pan: no hay que deshacerlos a mano.
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  }, []);

  /** Punto de la vuelta más cercano a una coordenada del SVG. */
  const puntoCercano = useCallback(
    (clientX: number, clientY: number) => {
      if (!projected) return -1;
      const pt = aCoordenadas(clientX, clientY);
      if (!pt) return -1;

      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < projected.length; i++) {
        const dx = projected[i].x - pt.x;
        const dy = projected[i].y - pt.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return bestDist < 140 ? best : -1;
    },
    [projected, aCoordenadas]
  );

  // Solo arrastra: mover el mouse sobre la pista ya no cambia el playhead,
  // así se puede explorar el mapa sin interrumpir la reproducción.
  const handleMove = useCallback((e: React.MouseEvent) => {
    if (!arrastre.current) return;

    // Los deltas se calculan antes del setState: el updater corre después y
    // para entonces el mouseup pudo haber dejado la referencia en null.
    const dx = e.clientX - arrastre.current.x;
    const dy = e.clientY - arrastre.current.y;
    arrastre.current = { x: e.clientX, y: e.clientY };

    setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, []);

  /**
   * Zoom hacia el cursor. Con la transformación
   *   translate(centro + pan) · scale(z) · translate(-centro)
   * un punto p del espacio local cae en (p - c)·z + c + pan. Para que el punto
   * bajo el cursor no se mueva al cambiar z, hay que compensar el pan.
   */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const local = aCoordenadas(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;

      setZoom((z) => {
        const nuevo = Math.min(Math.max(z * factor, 1), 6);
        if (nuevo === z) return z;

        if (local) {
          const dz = z - nuevo;
          setPan((prev) => ({
            x: nuevo === 1 ? 0 : prev.x + (local.x - VIEW_W / 2) * dz,
            y: nuevo === 1 ? 0 : prev.y + (local.y - VIEW_H / 2) * dz,
          }));
        }
        return nuevo;
      });
    },
    [aCoordenadas]
  );

  if (!projected) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-neutral-600">
        sin datos de pista
      </div>
    );
  }

  const idx = Math.min(playhead, projected.length - 1);
  const auto = projected[idx];
  const info = points[idx];
  const largada = projected[0];

  // El cartel se aleja del auto y se une con una línea, así no tapa la pista.
  const haciaDerecha = auto.x < VIEW_W * 0.55;
  const cx = haciaDerecha ? auto.x + 52 : auto.x - 52;
  const cy = auto.y - 42 < 40 ? auto.y + 42 : auto.y - 42;
  const cw = 96;
  const ch = 40;
  const bx = Math.min(Math.max(cx - cw / 2, 2), VIEW_W - cw - 2);
  const by = Math.min(Math.max(cy - ch / 2, 2), VIEW_H - ch - 2);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={`min-h-0 flex-1 touch-none ${zoom > 1 ? "cursor-grab" : "cursor-pointer"}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={handleWheel}
        onMouseDown={(e) => {
          if (zoom > 1) arrastre.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          // El salto al punto se hace por click, no por hover.
          const i = puntoCercano(e.clientX, e.clientY);
          if (i >= 0) onScrub(i);
        }}
        onMouseUp={() => {
          arrastre.current = null;
        }}
        onMouseLeave={() => {
          arrastre.current = null;
        }}
        onMouseMove={handleMove}
        onDoubleClick={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}
      >
        <g
          ref={gRef}
          transform={`translate(${VIEW_W / 2 + pan.x} ${VIEW_H / 2 + pan.y}) scale(${zoom}) translate(${-VIEW_W / 2} ${-VIEW_H / 2})`}
        >
          {paths.tramos.map((d, i) => (
            <path
              key={`t${i}`}
              d={d}
              fill="none"
              stroke="#3f3f46"
              strokeWidth={5 / Math.sqrt(zoom)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {paths.frenadas.map((d, i) => (
            <path
              key={`f${i}`}
              d={d}
              fill="none"
              stroke={F1_RED}
              strokeWidth={5 / Math.sqrt(zoom)}
              strokeLinecap="round"
              opacity={0.6}
            />
          ))}

          <circle
            cx={largada.x}
            cy={largada.y}
            r={4 / Math.sqrt(zoom)}
            fill="none"
            stroke="#a1a1aa"
            strokeWidth={1.5 / zoom}
          />

          <circle cx={auto.x} cy={auto.y} r={11 / Math.sqrt(zoom)} fill={color} opacity={0.22} />
          <circle cx={auto.x} cy={auto.y} r={5 / Math.sqrt(zoom)} fill={color} />
        </g>

        {/* El cartel vive fuera del <g> con zoom: así no se agranda ni se
            deforma al acercar. La línea guía sí sigue al auto. */}
        <g pointerEvents="none">
          <line
            x1={VIEW_W / 2 + pan.x + (auto.x - VIEW_W / 2) * zoom}
            y1={VIEW_H / 2 + pan.y + (auto.y - VIEW_H / 2) * zoom}
            x2={bx + cw / 2}
            y2={by + ch / 2}
            stroke="#52525b"
            strokeWidth={1}
          />
          <rect x={bx} y={by} width={cw} height={ch} fill="#0a0a0a" stroke={color} strokeWidth={1} />
          {etiqueta && (
            <text x={bx + 7} y={by + 13} fill={color} fontSize={9} fontFamily="monospace">
              {etiqueta}
            </text>
          )}
          <text
            x={bx + 7}
            y={by + (etiqueta ? 28 : 22)}
            fill="#fafafa"
            fontSize={14}
            fontFamily="monospace"
          >
            {Math.round(info?.speed ?? 0)}
            <tspan fontSize={8} fill="#a1a1aa"> km/h</tspan>
          </text>
          <text
            x={bx + cw - 7}
            y={by + (etiqueta ? 28 : 22)}
            fill="#a1a1aa"
            fontSize={9}
            fontFamily="monospace"
            textAnchor="end"
          >
            {info?.brake ? "FRENA" : `M${info?.gear ?? 0}`}
          </text>
        </g>
      </svg>

      <div className="flex items-center gap-3 px-1 pt-2 text-[10px] text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-[#3f3f46]" /> acelerando
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-[#E10600]" /> frenando
        </span>
        <span className="ml-auto">
          {zoom > 1 ? `${zoom.toFixed(1)}× · doble click para volver` : "rueda para acercar · click para saltar"}
        </span>
      </div>
    </div>
  );
}

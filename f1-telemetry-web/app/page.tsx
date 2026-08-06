"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Activity, Info, Pause, Play } from "lucide-react";
import TelemetryChart from "./components/telemetry-chart";
import TrackMap from "./components/track-map";
import { useTelemetry } from "./hooks/use-telemetry";
import { useStrategy } from "./hooks/use-strategy";
import StrategyCard from "./components/strategy-card";
import InfoPanel from "./components/info-panel";
import { apellido, fechaCorta, usePilotosPorEquipo, useCatalogo } from "./hooks/use-catalogo";
import { enriquecer } from "./lib/derive";
import type { TelemetryPointExt } from "./lib/types";

// El canvas de three.js no puede renderizarse en el server: sin ssr:false
// el build de Next rompe al intentar tocar window/WebGL.
const CarViewer = dynamic(() => import("./components/car-viewer"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#121212]" />,
});

// Base del playback: 20 fps alcanza para que se vea fluido y evita disparar
// un setState en cada frame del navegador. La velocidad divide este intervalo.
const PLAYBACK_MS = 50;
const VELOCIDADES = [0.5, 1, 2, 4];

// Colores oficiales de escudería, para el marcador y el cartel del minimapa.
const COLOR_EQUIPO: Record<string, string> = {
  "Red Bull Racing": "#3671C6",
  Ferrari: "#E8002D",
  McLaren: "#FF8000",
  Mercedes: "#27F4D2",
  "Aston Martin": "#229971",
  Alpine: "#FF87BC",
  Williams: "#64C4FF",
  RB: "#6692FF",
  "Kick Sauber": "#52E252",
  "Haas F1 Team": "#B6BABD",
};

export default function Page() {
  const { catalogo, error: errorCatalogo } = useCatalogo();

  // Clave compuesta "2025|qatar_grand_prix": el mismo circuito existe en
  // varias temporadas, así que el slug solo no identifica una carrera.
  const [gpKey, setGpKey] = useState<string | null>(null);
  const [driver, setDriver] = useState<string | null>(null);
  const [lap, setLap] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [velocidad, setVelocidad] = useState(1);
  const [info, setInfo] = useState(false);

  const circuito = useMemo(
    () => catalogo?.circuitos.find((c) => `${c.year}|${c.slug}` === gpKey),
    [catalogo, gpKey]
  );
  const porEquipo = usePilotosPorEquipo(circuito);

  // Selección inicial cuando llega el catálogo.
  useEffect(() => {
    if (!catalogo || gpKey) return;
    // Arranca en la última carrera ingestada, no en la primera del calendario.
    const conDatos = catalogo.circuitos.filter((c) => c.tiene_datos);
    const primero = conDatos[conDatos.length - 1];
    if (!primero) return;
    setGpKey(`${primero.year}|${primero.slug}`);
    setDriver(primero.pilotos[0]?.code ?? null);
  }, [catalogo, gpKey]);

  // Al cambiar de circuito puede que el piloto elegido no haya corrido ahí.
  useEffect(() => {
    if (!circuito || !driver) return;
    if (!circuito.pilotos.some((p) => p.code === driver)) {
      setDriver(circuito.pilotos[0]?.code ?? null);
    }
  }, [circuito, driver]);

  const { data, bounds, lapsDisponibles, lapActual, loading, error } = useTelemetry({
    gp: circuito?.slug ?? null,
    driver,
    lap,
    year: circuito?.year ?? 2024,
  });

  // Cuando no se pidió vuelta, la API elige una representativa y la informa.
  // Se adopta acá para que el selector muestre la que se está viendo.
  useEffect(() => {
    if (lap === null && lapActual !== null) setLap(lapActual);
  }, [lap, lapActual]);

  // Las fuerzas G no vienen en la telemetría oficial: se derivan de la
  // trayectoria y la velocidad, una sola vez por vuelta cargada.
  const puntos = useMemo(() => enriquecer(data), [data]);

  // Estado derivado: todo el dashboard lee de acá, nunca de su propio índice.
  const current = puntos[playhead];

  const piloto = useMemo(
    () => circuito?.pilotos.find((p) => p.code === driver),
    [circuito, driver]
  );

  // El punto entero viaja al visor 3D por ref: los LED, el DRS y los discos
  // se leen dentro de useFrame, así el Canvas nunca se re-renderiza.
  const telemetryRef = useRef<TelemetryPointExt | null>(null);
  useEffect(() => {
    telemetryRef.current = current ?? null;
  }, [current]);

  useEffect(() => {
    setPlayhead(0);
  }, [gpKey, driver, lap]);

  // Al cambiar de circuito o piloto, la vuelta anterior puede no existir:
  // se vuelve a null y la API elige una válida.
  useEffect(() => {
    setLap(null);
  }, [gpKey, driver]);

  const handleScrub = useCallback((index: number) => {
    setPlaying(false);
    setPlayhead(index);
  }, []);

  useEffect(() => {
    if (!playing || data.length === 0) return;
    const id = setInterval(() => {
      setPlayhead((prev) => (prev + 1 >= data.length ? 0 : prev + 1));
    }, PLAYBACK_MS / velocidad);
    return () => clearInterval(id);
  }, [playing, data.length, velocidad]);

  const estrategia = useStrategy(circuito?.year ?? 2024, circuito?.slug ?? null, driver);

  const progreso = data.length > 1 ? (playhead / (data.length - 1)) * 100 : 0;

  return (
    <>
      {/* El dashboard es una herramienta de varios paneles simultáneos: en un
          teléfono no se puede leer. Mejor decirlo que mostrar algo roto. */}
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-[#121212] px-8 text-center font-mono text-neutral-400 lg:hidden">
        <span className="flex h-10 w-10 items-center justify-center bg-[#E10600] text-sm font-bold text-white">
          F1
        </span>
        <p className="text-sm tracking-[0.2em] text-neutral-100">F1 TELEMETRY ENGINE</p>
        <p className="max-w-xs text-[12px] leading-relaxed">
          Este panel muestra telemetría, mapa de pista y un visor 3D al mismo tiempo. Necesita
          una pantalla de escritorio para que se entienda.
        </p>
        <p className="text-[11px] text-neutral-600">Abrilo desde una computadora</p>
      </div>

      <main className="relative hidden h-dvh grid-cols-[56px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] overflow-hidden bg-[#121212] font-mono text-neutral-200 lg:grid">
      {/* Sidebar: solo dos entradas, y las dos hacen algo. Iconos que no
          llevan a ningún lado restan más de lo que decoran. */}
      <aside className="row-span-2 flex min-h-0 flex-col items-center border-r border-neutral-800">
        <div className="flex h-14 w-full items-center justify-center border-b border-neutral-800">
          <span className="flex h-8 w-8 items-center justify-center bg-[#E10600] text-sm font-bold text-white">
            F1
          </span>
        </div>

        <button
          className="mt-2 flex h-10 w-10 items-center justify-center border-l-2 border-[#E10600] text-[#E10600]"
          aria-label="Telemetría"
          title="Telemetría"
        >
          <Activity size={18} />
        </button>

        <button
          onClick={() => setInfo(true)}
          className="mt-auto mb-3 flex h-10 w-10 items-center justify-center text-neutral-500 transition hover:text-neutral-200"
          aria-label="Sobre el proyecto"
          title="Sobre el proyecto"
        >
          <Info size={18} />
        </button>
      </aside>

      {/* Topbar */}
      <header className="flex items-center justify-between gap-4 border-b border-neutral-800 px-5">
        <div className="flex items-baseline gap-3">
          <h1 className="whitespace-nowrap text-sm tracking-[0.2em] text-neutral-100">
            F1 TELEMETRY ENGINE
          </h1>
          <span className="hidden text-[11px] text-neutral-600 xl:inline">
            {circuito
              ? `${circuito.year} · ronda ${circuito.ronda} · ${fechaCorta(circuito.fecha)}`
              : "datos oficiales de la FIA"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setPlaying((p) => !p)}
            disabled={data.length === 0}
            className="flex items-center gap-2 border border-neutral-700 px-3 py-1.5 text-[11px] tracking-widest text-neutral-300 hover:border-neutral-500 disabled:opacity-40"
          >
            {playing ? <Pause size={12} /> : <Play size={12} />}
            {playing ? "PAUSA" : "PLAY"}
          </button>

          <button
            onClick={() =>
              setVelocidad((v) => VELOCIDADES[(VELOCIDADES.indexOf(v) + 1) % VELOCIDADES.length])
            }
            className="border border-neutral-700 px-2 py-1.5 text-[11px] tracking-widest text-neutral-400 hover:border-neutral-500"
            title="Velocidad de reproducción"
          >
            {velocidad}×
          </button>

          <Select
            value={gpKey ?? ""}
            onChange={setGpKey}
            disabled={!catalogo}
            ancho="w-[150px]"
          >
            {catalogo?.years.map((y) => {
              const delAnio = catalogo.circuitos.filter((c) => c.year === y);
              if (delAnio.length === 0) return null;
              return (
                <optgroup key={y} label={String(y)}>
                  {delAnio.map((c) => (
                    // Sin datos = no seleccionable, pero visible: así se ve
                    // qué falta ingestar y qué todavía no se corrió.
                    <option
                      key={`${y}-${c.slug}`}
                      value={`${c.year}|${c.slug}`}
                      disabled={!c.tiene_datos}
                    >
                      {c.nombre}
                      {c.tiene_datos ? "" : c.corrida ? " · sin datos" : " · no corrida"}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>

          {/* Los pilotos salen del catálogo y vienen agrupados por escudería:
              cambiar de temporada no requiere tocar código. */}
          <Select
            value={driver ?? ""}
            onChange={setDriver}
            disabled={!circuito}
            ancho="w-[165px]"
          >
            {porEquipo.map(({ team, pilotos }) => (
              <optgroup key={team} label={team}>
                {pilotos.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} · {apellido(p.name)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>

          {/* Sin opción de "carrera completa": Distance se reinicia en cada
              vuelta, así que mostrarlas todas juntas superpone 50 trazados. */}
          <Select
            value={lap === null ? "" : String(lap)}
            onChange={(v) => setLap(v ? Number(v) : null)}
            disabled={lapsDisponibles.length === 0}
            ancho="w-[130px]"
          >
            {lap === null && <option value="">Vuelta…</option>}
            {lapsDisponibles.map((l) => (
              <option key={l} value={l}>
                Vuelta {l}
              </option>
            ))}
          </Select>

          <span className="hidden items-center gap-2 border border-emerald-900 px-3 py-1.5 text-[11px] tracking-widest text-emerald-400 2xl:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            AWS S3
          </span>
        </div>
      </header>

      {/* Grilla principal. min-h-0 en cada nivel: sin eso, los hijos usan
          min-height:auto, no se pueden encoger y empujan scroll en el body. */}
      <section className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px] grid-rows-[minmax(0,1fr)_300px] gap-px bg-neutral-800">
        <div className="flex min-h-0 flex-col bg-[#1a1a1a]">
          <PanelLabel
            title="A · EL AUTO"
            hint={
              piloto ? `${piloto.name} · ${piloto.team}` : "elegí un piloto"
            }
          />
          <div className="min-h-0 flex-1">
            <CarViewer telemetryRef={telemetryRef} />
          </div>
          <div className="grid grid-cols-5 border-t border-neutral-800">
            <Kpi label="VELOCIDAD" value={Math.round(current?.speed ?? 0)} unit="km/h" />
            <Kpi label="RPM" value={(current?.rpm ?? 0).toLocaleString("es-AR")} />
            <Kpi label="MARCHA" value={current?.gear ?? 0} />
            <Kpi
              label="FUERZA G"
              value={(current?.gLat ?? 0).toFixed(1)}
              unit="lat"
              accent={(current?.gLat ?? 0) > 3 ? "text-[#E10600]" : "text-neutral-100"}
            />
            <Kpi
              label="FRENO"
              value={current?.brake ? "SÍ" : "NO"}
              accent={current?.brake ? "text-[#E10600]" : "text-neutral-600"}
            />
          </div>
        </div>

        <aside className="row-span-2 flex min-h-0 flex-col bg-[#1a1a1a]">
          <PanelLabel
            title="B · LA PISTA"
            hint={
              circuito
                ? `${circuito.nombre} · vuelta ${lap ?? "…"} de ${circuito.vueltas ?? "?"} · ${Math.round(progreso)}%`
                : ""
            }
          />
          <div className="min-h-0 flex-1 px-3 pb-3">
            {circuito && !circuito.posicion_ok ? (
              // Dibujar el circuito con posiciones repetidas da un trazado en
              // pedazos que parece un error del dashboard. Es mejor decir que
              // el dato no está.
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-[11px] tracking-widest text-amber-600">SIN MAPA DE PISTA</p>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  El cronometraje oficial no registró la posición del auto en esta carrera.
                  La telemetría de velocidad, marchas y frenos sí está disponible.
                </p>
                <p className="text-[10px] text-neutral-700">
                  coordenadas útiles: {Math.round((circuito.posicion_calidad ?? 0) * 100)}%
                </p>
              </div>
            ) : (
            <TrackMap
              points={puntos}
              bounds={bounds}
              playhead={playhead}
              onScrub={handleScrub}
              color={piloto ? COLOR_EQUIPO[piloto.team] ?? "#E10600" : "#E10600"}
              etiqueta={driver ?? undefined}
            />
            )}
          </div>

          <StrategyCard
            prediccion={estrategia.prediccion}
            resumen={estrategia.resumen}
            modelo={estrategia.modelo}
            error={estrategia.error}
          />
        </aside>

        <div className="flex min-h-0 flex-col bg-[#1a1a1a]">
          <PanelLabel
            title="D · LA VUELTA"
            hint={
              loading
                ? "cargando…"
                : "Velocidad y acelerador a lo largo del recorrido. Los valles son frenadas."
            }
          />
          <div className="min-h-0 flex-1">
            {errorCatalogo ? (
              <p className="p-4 text-xs text-[#E10600]">{errorCatalogo}</p>
            ) : error ? (
              <p className="p-4 text-xs text-[#E10600]">{error}</p>
            ) : (
              <TelemetryChart data={puntos} playhead={playhead} onScrub={handleScrub} />
            )}
          </div>
          {/* Barra de recorrido. El relleno se dibuja con un gradiente sobre
              el propio input: así se ve el avance como en un reproductor, sin
              montar un slider a mano. */}
          <div className="flex items-center gap-3 border-t border-neutral-800 px-4 py-2.5">
            <button
              onClick={() => setPlaying((v) => !v)}
              disabled={puntos.length === 0}
              className="shrink-0 text-neutral-400 hover:text-neutral-100 disabled:opacity-40"
              aria-label={playing ? "Pausar" : "Reproducir"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>

            <span className="w-16 shrink-0 font-mono text-[10px] text-neutral-400">
              {Math.round(current?.distance ?? 0)}m
            </span>

            <input
              type="range"
              min={0}
              max={Math.max(puntos.length - 1, 0)}
              value={playhead}
              onChange={(e) => setPlayhead(Number(e.target.value))}
              style={{
                background: `linear-gradient(to right, #E10600 ${progreso}%, #3f3f46 ${progreso}%)`,
              }}
              className="h-1 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#E10600]"
            />

            <span className="w-16 shrink-0 text-right font-mono text-[10px] text-neutral-500">
              {Math.round(puntos[puntos.length - 1]?.distance ?? 0)}m
            </span>
          </div>

          <div className="flex items-center gap-4 border-t border-neutral-800 px-4 py-2 text-[10px] text-neutral-500">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-[#E10600]" /> velocidad (km/h)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 border-t border-dashed border-neutral-300" /> acelerador (%)
            </span>
            <span className="ml-auto">
              {puntos.length} mediciones{driver ? ` · ${driver}` : ""}
            </span>
          </div>
        </div>
      </section>

        {info && <InfoPanel onClose={() => setInfo(false)} />}
      </main>
    </>
  );
}

function Select({
  value,
  onChange,
  disabled,
  ancho,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  ancho: string;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`${ancho} truncate border border-neutral-700 bg-[#1a1a1a] px-2 py-1.5 text-[11px] text-neutral-100 outline-none disabled:opacity-40`}
    >
      {children}
    </select>
  );
}

function PanelLabel({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <span className="whitespace-nowrap text-[11px] tracking-widest text-[#E10600]">{title}</span>
      {hint && <span className="truncate text-[11px] text-neutral-500">{hint}</span>}
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  accent = "text-neutral-100",
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent?: string;
}) {
  return (
    <div className="px-3 py-3">
      <p className="text-[10px] tracking-widest text-neutral-500">{label}</p>
      <p className={`text-xl leading-tight ${accent}`}>
        {value}
        {unit && <span className="ml-1 text-[10px] text-neutral-500">{unit}</span>}
      </p>
    </div>
  );
}

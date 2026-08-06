"use client";

import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  AdaptiveDpr,
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import { Box3, MeshStandardMaterial, Vector3, type Mesh, type Object3D } from "three";
import type { TelemetryPointExt } from "../lib/types";

const MODEL_URL = "/models/f1_rb22.glb";
useGLTF.preload(MODEL_URL);

type HotspotKey =
  | "tyre" | "wheel" | "brake" | "susp" | "steer"
  | "cockpit" | "rearwing" | "mirror" | "body";

type Hotspot = { key: HotspotKey; match: string[]; label: string; explica: string };

// El modelo nombra ruedas, frenos, suspensión, cockpit y volante. La
// carrocería quedó como Cube / Plane_00X, así que todo lo que no matchea cae
// en "body" y se enfoca el mesh clickeado: ninguna parte queda muerta.
const HOTSPOTS: Hotspot[] = [
  {
    key: "tyre",
    match: ["TYRE_"],
    label: "NEUMÁTICO",
    explica:
      "Pierde agarre a medida que se gasta. Cuánto se degrada define en qué vuelta conviene entrar a boxes: es la variable que predice el modelo.",
  },
  {
    key: "brake",
    match: ["disc_", "hub_caliper"],
    label: "FRENOS",
    explica:
      "Discos de carbono que superan los 1000 °C en una frenada fuerte. El auto baja de 300 a 100 km/h en poco más de cien metros.",
  },
  {
    key: "wheel",
    match: ["WHEEL_", "wheel_"],
    label: "LLANTA",
    explica: "Llanta de 18 pulgadas. En recta gira a unas 50 vueltas por segundo.",
  },
  {
    key: "susp",
    match: ["SUSP_", "SUS_", "suspension", "susp", "tether"],
    label: "SUSPENSIÓN",
    explica:
      "Además de absorber el piso, mantiene la altura del auto estable. Si la altura cambia, cambia toda la carga aerodinámica.",
  },
  {
    key: "steer",
    match: ["STEER", "rtt_sw"],
    label: "VOLANTE",
    explica:
      "Las luces de arriba avisan cuándo cambiar de marcha: se encienden progresivamente con el régimen del motor.",
  },
  {
    key: "cockpit",
    match: ["cockpit", "headrest", "CINTURE", "safetycell", "windscreen"],
    label: "COCKPIT",
    explica:
      "Monocasco de fibra de carbono con el halo encima. Es la celda de seguridad que rodea al piloto.",
  },
  {
    key: "rearwing",
    match: ["rearwing", "rearendplates", "TAG_DRS"],
    label: "ALERÓN TRASERO · DRS",
    explica:
      "El DRS abre una aleta para reducir la resistencia al aire y ganar unos 10 a 15 km/h. Solo se puede usar en zonas marcadas y a menos de un segundo del de adelante.",
  },
  {
    key: "mirror",
    match: ["mirror", "MIRROR"],
    label: "ESPEJO",
    explica: "Obligatorio por reglamento. Con el halo y el casco, la visión hacia atrás es mínima.",
  },
];

const BODY: Hotspot = {
  key: "body",
  match: [],
  label: "CARROCERÍA",
  explica:
    "Cada superficie está diseñada para generar carga aerodinámica: empuja el auto contra el piso y le permite doblar mucho más rápido de lo que agarraría el neumático solo.",
};

const RPM_MIN = 8000;
const RPM_MAX = 12000;
const SHIFT_LIGHTS = 15;

type Props = {
  /** Punto de telemetría actual. Llega por ref, no por props: se lee dentro
   *  de useFrame y el Canvas nunca se re-renderiza por el playhead. */
  telemetryRef: React.MutableRefObject<TelemetryPointExt | null>;
};

function buscarHotspot(obj: Object3D): { hotspot: Hotspot; node: Object3D } {
  let node: Object3D | null = obj;
  while (node) {
    const name = node.name ?? "";
    const hit = HOTSPOTS.find((h) => h.match.some((m) => name.includes(m)));
    if (hit) return { hotspot: hit, node };
    node = node.parent;
  }
  return { hotspot: BODY, node: obj };
}

/**
 * Cámara manual en vez de <Bounds observe>: ese componente reencuadra el auto
 * entero por su cuenta y termina peleándose con el zoom a una pieza.
 */
function CameraRig({ target, root }: { target: Object3D | null; root: Object3D | null }) {
  const { camera, controls } = useThree();
  const destino = useRef(new Vector3());
  const centro = useRef(new Vector3());
  const activo = useRef(false);
  const frames = useRef(0);

  // En cuanto el usuario arrastra o hace zoom, la animación se cancela.
  // Sin esto el lerp le devuelve la cámara a su posición y parece trabada.
  useEffect(() => {
    const c = controls as unknown as {
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    } | null;
    if (!c?.addEventListener) return;

    const cancelar = () => {
      activo.current = false;
    };
    c.addEventListener("start", cancelar);
    return () => c.removeEventListener?.("start", cancelar);
  }, [controls]);

  useEffect(() => {
    const obj = target ?? root;
    if (!obj) return;

    const box = new Box3().setFromObject(obj);
    if (box.isEmpty()) return;

    const size = box.getSize(new Vector3());
    box.getCenter(centro.current);

    const radio = Math.max(size.x, size.y, size.z) * 0.5;
    const fov = ((camera as { fov?: number }).fov ?? 40) * (Math.PI / 180);
    const dist = Math.max((radio / Math.tan(fov / 2)) * 1.9, 0.5);

    // Se conserva la dirección desde la que el usuario venía mirando: girar el
    // auto y después clickear no debería teletransportar la cámara.
    const dir = camera.position.clone().sub(centro.current);
    if (dir.lengthSq() < 0.0001) dir.set(3, 2, 4);
    dir.normalize();

    destino.current.copy(centro.current).add(dir.multiplyScalar(dist));
    activo.current = true;
    frames.current = 0;
  }, [target, root, camera]);

  useFrame(() => {
    if (!activo.current) return;

    // Tope de seguridad: si en dos segundos no convergió, se suelta igual.
    frames.current += 1;
    if (frames.current > 120) {
      activo.current = false;
      return;
    }

    camera.position.lerp(destino.current, 0.12);

    const c = controls as unknown as { target?: Vector3; update?: () => void } | null;
    if (c?.target) {
      c.target.lerp(centro.current, 0.12);
      c.update?.();
    }

    if (camera.position.distanceTo(destino.current) < 0.05) activo.current = false;
  });

  return null;
}

function Car({
  telemetryRef,
  onSelect,
  onReady,
}: Props & {
  onSelect: (h: Hotspot, node: Object3D) => void;
  onReady: (scene: Object3D, pisoY: number) => void;
}) {
  const { scene } = useGLTF(MODEL_URL);

  const rig = useMemo(() => {
    const leds: { mesh: Mesh; index: number }[] = [];
    const discos: Mesh[] = [];
    let alaMovil: Object3D | null = null;

    scene.traverse((child) => {
      const name = child.name ?? "";
      if (name.includes("rearwingmoving")) alaMovil = child;
      if (!(child as Mesh).isMesh) return;
      const mesh = child as Mesh;

      const led = name.match(/LED_KERS_(\d+)/);
      if (led) {
        // Los 58 LED comparten un material en el archivo original: sin clonar,
        // se encenderían todos juntos.
        mesh.material = (mesh.material as MeshStandardMaterial).clone();
        leds.push({ mesh, index: Number(led[1]) });
        return;
      }

      if (name.startsWith("disc_")) {
        mesh.material = (mesh.material as MeshStandardMaterial).clone();
        discos.push(mesh);
        return;
      }

      // La carrocería es oscura y rugosa: sin subir la respuesta al entorno,
      // ningún reflejo la levanta y el auto se ve como una silueta.
      const mat = mesh.material as MeshStandardMaterial;
      if (mat && "envMapIntensity" in mat) {
        mat.envMapIntensity = 2.2;
        mat.roughness = Math.max(mat.roughness * 0.75, 0.08);
      }
    });

    leds.sort((a, b) => a.index - b.index);
    return { leds, discos, alaMovil };
  }, [scene]);

  // El modelo no apoya necesariamente en y=0: se mide dónde está su punto más
  // bajo para poder poner la sombra ahí y no atravesando el auto.
  useEffect(() => {
    const box = new Box3().setFromObject(scene);
    onReady(scene, box.isEmpty() ? 0 : box.min.y);
  }, [scene, onReady]);

  useFrame(() => {
    const t = telemetryRef.current;
    if (!t) return;

    const ratio = Math.min(Math.max((t.rpm - RPM_MIN) / (RPM_MAX - RPM_MIN), 0), 1);
    const encendidos = Math.round(ratio * rig.leds.length);

    for (let i = 0; i < rig.leds.length; i++) {
      const mat = rig.leds[i].mesh.material as MeshStandardMaterial;
      if (i < encendidos) {
        const p = i / rig.leds.length;
        // Verde abajo, naranja al medio, azul arriba: igual que el auto real.
        if (p > 0.8) mat.emissive.setRGB(0.2, 0.3, 1);
        else if (p > 0.5) mat.emissive.setRGB(1, 0.4, 0);
        else mat.emissive.setRGB(0, 1, 0);
        mat.emissiveIntensity = 3;
      } else {
        mat.emissiveIntensity = 0;
      }
    }

    for (const disco of rig.discos) {
      const mat = disco.material as MeshStandardMaterial;
      mat.emissive.setRGB(1, 0.15, 0);
      mat.emissiveIntensity = t.brake ? 2.5 : 0;
    }

    // DRS: los valores 10, 12 y 14 del timing significan alerón abierto.
    if (rig.alaMovil) {
      const w = rig.alaMovil as Object3D;
      const objetivo = t.drs >= 10 ? -0.5 : 0;
      w.rotation.x += (objetivo - w.rotation.x) * 0.15;
    }
  });

  return (
    <primitive
      object={scene}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        const { hotspot, node } = buscarHotspot(e.object);
        onSelect(hotspot, node);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    />
  );
}

/**
 * Lectura de la pieza elegida, en vivo. Igual que las luces: un rAF escribe
 * el texto directo en el DOM, así el valor sigue al playhead sin que el panel
 * se re-renderice ni haya que congelar un snapshot al hacer click.
 */
function LecturaViva({ telemetryRef, tipo }: Props & { tipo: HotspotKey }) {
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  const c = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;

    const loop = () => {
      const t = telemetryRef.current;
      if (t) {
        // Cada zona muestra la magnitud que de verdad la describe, no siempre
        // velocidad: los frenos importan por la desaceleración, la carrocería
        // por la carga aerodinámica, el neumático por la fuerza lateral.
        let l1: [string, string];
        let l2: [string, string];
        let l3: [string, string] | null = null;
        let color = "#fafafa";

        switch (tipo) {
          case "tyre":
            l1 = ["carga lateral", `${t.gLat.toFixed(1)} G`];
            l2 = ["compuesto", t.compound ? t.compound.toLowerCase() : "—"];
            l3 = ["acelerador", `${t.throttle}%`];
            color = t.gLat > 3 ? "#E10600" : "#fafafa";
            break;

          case "brake":
            l1 = ["desaceleración", `${Math.abs(Math.min(t.gLon, 0)).toFixed(1)} G`];
            l2 = ["velocidad", `${Math.round(t.speed)} km/h`];
            l3 = ["freno", t.brake ? "PISADO" : "suelto"];
            color = t.brake ? "#E10600" : "#fafafa";
            break;

          case "wheel":
            l1 = ["vueltas por segundo", `${(t.speed / 3.6 / (Math.PI * 0.72)).toFixed(0)}`];
            l2 = ["velocidad", `${Math.round(t.speed)} km/h`];
            break;

          case "susp":
            l1 = ["carga lateral", `${t.gLat.toFixed(1)} G`];
            l2 = ["longitudinal", `${t.gLon.toFixed(1)} G`];
            color = t.gLat > 3 ? "#E10600" : "#fafafa";
            break;

          case "steer":
            l1 = ["régimen", `${t.rpm.toLocaleString("es-AR")} rpm`];
            l2 = ["marcha", String(t.gear)];
            l3 = ["acelerador", `${t.throttle}%`];
            break;

          case "rearwing":
            l1 = ["DRS", t.drs >= 10 ? "ABIERTO" : "cerrado"];
            l2 = ["velocidad", `${Math.round(t.speed)} km/h`];
            color = t.drs >= 10 ? "#34d399" : "#fafafa";
            break;

          case "mirror":
            l1 = ["velocidad", `${Math.round(t.speed)} km/h`];
            l2 = ["marcha", String(t.gear)];
            break;

          default:
            // Carga aerodinámica: crece con el cuadrado de la velocidad.
            // A 300 km/h un F1 genera más peso en downforce que el del auto.
            l1 = ["fuerza G sobre el piloto", `${t.gLat.toFixed(1)} G`];
            l2 = ["carga aerodinámica", `${((t.speed / 300) ** 2 * 100).toFixed(0)}%`];
            l3 = ["velocidad", `${Math.round(t.speed)} km/h`];
            color = t.gLat > 3 ? "#E10600" : "#fafafa";
        }

        const pintar = (el: HTMLSpanElement | null, par: [string, string] | null) => {
          if (!el) return;
          if (!par) {
            el.textContent = "";
            return;
          }
          el.innerHTML = "";
          const k = document.createElement("span");
          k.textContent = par[0] + " ";
          k.style.color = "#737373";
          const v = document.createElement("span");
          v.textContent = par[1];
          el.append(k, v);
        };

        pintar(a.current, l1);
        pintar(b.current, l2);
        pintar(c.current, l3);
        if (a.current) (a.current.lastChild as HTMLElement).style.color = color;
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [telemetryRef, tipo]);

  return (
    <div className="mt-3 flex flex-col gap-0.5 border-t border-neutral-800 pt-2 text-[11px] text-neutral-100">
      <span ref={a} />
      <span ref={b} />
      <span ref={c} />
    </div>
  );
}

/**
 * Fichas siempre visibles con las magnitudes que describen al auto en cada
 * instante. El click sobre una pieza sigue existiendo para profundizar, pero
 * la información básica no puede depender de que alguien lo descubra.
 *
 * El contenedor no captura eventos: el arrastre para rotar sigue funcionando
 * aunque el cursor pase por encima de las fichas.
 */
function FichasVivas({ telemetryRef }: Props) {
  const gLat = useRef<HTMLSpanElement>(null);
  const gLon = useRef<HTMLSpanElement>(null);
  const aero = useRef<HTMLSpanElement>(null);
  const pieNeu = useRef<HTMLSpanElement>(null);
  const pieFre = useRef<HTMLSpanElement>(null);
  const pieAero = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = telemetryRef.current;
      if (t) {
        if (gLat.current) {
          gLat.current.textContent = `${t.gLat.toFixed(1)} G`;
          gLat.current.style.color = t.gLat > 3 ? "#E10600" : "#fafafa";
        }
        if (pieNeu.current) {
          pieNeu.current.textContent = t.compound ? t.compound.toLowerCase() : "—";
        }

        const frenada = Math.abs(Math.min(t.gLon, 0));
        if (gLon.current) {
          gLon.current.textContent = `${frenada.toFixed(1)} G`;
          gLon.current.style.color = t.brake ? "#E10600" : "#fafafa";
        }
        if (pieFre.current) {
          pieFre.current.textContent = t.brake ? "freno pisado" : "sin freno";
        }

        // Crece con el cuadrado de la velocidad: a 300 km/h un F1 genera más
        // carga hacia el piso que su propio peso.
        if (aero.current) aero.current.textContent = `${((t.speed / 300) ** 2 * 100).toFixed(0)}%`;
        if (pieAero.current) pieAero.current.textContent = `${Math.round(t.speed)} km/h`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [telemetryRef]);

  return (
    <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
      <Ficha titulo="NEUMÁTICOS" etiqueta="carga lateral" valorRef={gLat} pieRef={pieNeu} />
      <Ficha titulo="FRENOS" etiqueta="desaceleración" valorRef={gLon} pieRef={pieFre} />
      <Ficha titulo="AERODINÁMICA" etiqueta="carga" valorRef={aero} pieRef={pieAero} />
    </div>
  );
}

function Ficha({
  titulo,
  etiqueta,
  valorRef,
  pieRef,
}: {
  titulo: string;
  etiqueta: string;
  valorRef: React.RefObject<HTMLSpanElement | null>;
  pieRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="w-[132px] border border-neutral-800 bg-[#0a0a0a]/70 px-2.5 py-1.5">
      <p className="text-[9px] tracking-widest text-[#E10600]">{titulo}</p>
      <p className="mt-0.5 text-[10px] text-neutral-600">{etiqueta}</p>
      <span ref={valorRef} className="block text-lg leading-tight text-neutral-100">
        —
      </span>
      <span ref={pieRef} className="text-[10px] text-neutral-500">
        —
      </span>
    </div>
  );
}

/**
 * Luces de cambio sobre el canvas. Duplican los LED del volante, que quedan
 * escondidos salvo que gires la cámara al cockpit. Se actualizan por rAF
 * escribiendo el estilo directo: cero re-renders de React.
 */
function ShiftLights({ telemetryRef }: Props) {
  const barras = useRef<(HTMLSpanElement | null)[]>([]);
  const rpmRef = useRef<HTMLSpanElement>(null);
  const drsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = telemetryRef.current;
      if (t) {
        const ratio = Math.min(Math.max((t.rpm - RPM_MIN) / (RPM_MAX - RPM_MIN), 0), 1);
        const on = Math.round(ratio * SHIFT_LIGHTS);

        for (let i = 0; i < SHIFT_LIGHTS; i++) {
          const el = barras.current[i];
          if (!el) continue;
          const p = i / SHIFT_LIGHTS;
          el.style.background =
            i < on ? (p > 0.8 ? "#3b82f6" : p > 0.5 ? "#f59e0b" : "#22c55e") : "#27272a";
        }

        if (rpmRef.current) rpmRef.current.textContent = t.rpm.toLocaleString("es-AR");
        if (drsRef.current) drsRef.current.style.color = t.drs >= 10 ? "#34d399" : "#3f3f46";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [telemetryRef]);

  return (
    <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-3 border border-neutral-800 bg-[#0a0a0a]/80 px-3 py-1.5">
      <div className="flex gap-[3px]">
        {Array.from({ length: SHIFT_LIGHTS }).map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barras.current[i] = el;
            }}
            className="h-3 w-1.5 rounded-[1px] bg-neutral-800"
          />
        ))}
      </div>
      <span className="font-mono text-[10px] text-neutral-400">
        <span ref={rpmRef} className="text-neutral-100">0</span> rpm
      </span>
      <span ref={drsRef} className="font-mono text-[10px] text-neutral-700">DRS</span>
    </div>
  );
}

function CarViewer({ telemetryRef }: Props) {
  const [sel, setSel] = useState<{ hotspot: Hotspot } | null>(null);
  const [target, setTarget] = useState<Object3D | null>(null);
  const [root, setRoot] = useState<Object3D | null>(null);
  const [pisoY, setPisoY] = useState(0);

  const onSelect = useCallback((hotspot: Hotspot, node: Object3D) => {
    setSel({ hotspot });
    setTarget(node);
  }, []);

  const onReady = useCallback((scene: Object3D, y: number) => {
    setRoot(scene);
    setPisoY(y);
  }, []);

  const volver = useCallback(() => {
    setSel(null);
    setTarget(null);
  }, []);

  return (
    <div className="relative h-full min-h-0 w-full bg-[radial-gradient(ellipse_at_50%_45%,#33343a_0%,#232428_38%,#151517_75%,#101012_100%)]">
      <Canvas
        dpr={[1, 1.5]}
        performance={{ min: 0.5 }}
        camera={{ position: [4, 2, 5], fov: 40 }}
        gl={{ antialias: true, powerPreference: "high-performance", toneMappingExposure: 1.5 }}
        onPointerMissed={volver}
      >
        {/* Sin color de fondo: el Canvas queda transparente y deja ver el
            gradiente CSS del contenedor. Un degradé en DOM no cuesta GPU. */}

        <ambientLight intensity={0.45} />
        <hemisphereLight args={["#8ea6c0", "#101010", 0.7]} />
        <directionalLight position={[5, 8, 4]} intensity={2.2} />
        <directionalLight position={[-5, 3, -4]} intensity={1} color="#E10600" />

        {/* Entorno generado con estos paneles: da los reflejos que la
            carrocería necesita, sin descargar ningún HDRI. */}
        <Environment resolution={256} frames={1}>
          <Lightformer form="rect" intensity={6} position={[0, 6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 6, 1]} />
          <Lightformer form="rect" intensity={4} position={[-6, 2, 2]} rotation={[0, Math.PI / 2, 0]} scale={[8, 4, 1]} />
          <Lightformer form="rect" intensity={3} color="#E10600" position={[6, 2, -2]} rotation={[0, -Math.PI / 2, 0]} scale={[8, 3, 1]} />
          <Lightformer form="ring" intensity={2} position={[0, 1, 8]} scale={4} />
        </Environment>

        <Suspense fallback={null}>
          <Car telemetryRef={telemetryRef} onSelect={onSelect} onReady={onReady} />
        </Suspense>

        <CameraRig target={target} root={root} />

        {/* La sombra va al punto más bajo del modelo, no a y=0: si el auto no
            apoya en el origen, una sombra fija lo atraviesa. */}
        <ContactShadows
          position={[0, pisoY + 0.005, 0]}
          opacity={0.6}
          scale={9}
          blur={2.8}
          far={2}
          color="#0b0d16"
          frames={1}
        />

        <AdaptiveDpr pixelated />
        <OrbitControls makeDefault enablePan={false} minDistance={0.5} maxDistance={14} />
      </Canvas>

      <ShiftLights telemetryRef={telemetryRef} />

      {/* Al abrir la ficha de una pieza se ocultan, para no competir */}
      {!sel && <FichasVivas telemetryRef={telemetryRef} />}

      {sel ? (
        <div className="absolute bottom-3 left-3 max-w-[340px] border border-neutral-700 bg-[#0a0a0a]/95 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] tracking-widest text-[#E10600]">{sel.hotspot.label}</p>
            <button onClick={volver} className="text-[10px] text-neutral-500 hover:text-neutral-200">
              VOLVER
            </button>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{sel.hotspot.explica}</p>

          <LecturaViva telemetryRef={telemetryRef} tipo={sel.hotspot.key} />
        </div>
      ) : (
        <p className="pointer-events-none absolute bottom-3 left-3 text-[10px] text-neutral-600">
          hacé click en una parte del auto para ver qué mide · arrastrá para girar
        </p>
      )}
    </div>
  );
}

export default memo(CarViewer);

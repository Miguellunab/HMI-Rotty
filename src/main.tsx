import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import "@google/model-viewer";
import { $primitivesList } from "@google/model-viewer/lib/features/scene-graph/model.js";
import { Group, MathUtils, Vector3 } from "three";
import dmLogo from "./assets/brand/dm-logo.png";
import "./styles.css";

type AxisName = "X" | "Y" | "Z" | "W";
type BaudRate = 115200;
type View = "home" | "control";
type SendCommand = (command: string, waitsForStatus?: boolean) => void | Promise<void>;
type AxisPose = Record<AxisName, number>;
type GripperPose = "open" | "close";
type SceneObject = Group;

type RobotViewer = HTMLElement & {
  model?: { [$primitivesList]?: { mesh: SceneObject }[] };
};

interface Rig {
  x: Group;
  y: Group;
  z: Group;
  w: Group;
  jaws: { part: SceneObject; open: Vector3; close: Vector3 }[];
}

interface AxisStatus {
  homed: boolean;
  steps: number;
  unit: "deg" | "mm";
  pos: number;
  speed_sps: number;
  speed_us?: number;
  limit_configured?: boolean;
  limit: boolean;
}

interface MachineStatus {
  ok: true;
  type: "status";
  axes: Record<AxisName, AxisStatus>;
  gripper?: {
    ready: boolean;
    state: "open" | "close" | "custom";
    user_angle: number;
    physical_angle: number;
    open_user_angle: number;
    close_user_angle: number;
  };
  drivers_enabled?: boolean;
}

interface SerialEvent {
  direction: "tx" | "rx" | "error";
  line: string;
  timestamp: number;
}

const axes: AxisName[] = ["X", "Y", "Z", "W"];
const robotPivots = {
  x: new Vector3(0.0425, 0, -0.0175),
  y: new Vector3(0.2645644849, -0.0008773029, -0.1530041905),
  w: new Vector3(0.4053553898, 0.0199586406, -0.1470041904),
};
const zAxisBaseOffsetMm = 40;
const zAxisTravelMm = 180;
const gripperCloseTravelM = 0.02;
const robotRigs = new WeakMap<RobotViewer, Rig>();
const xOnlyParts = new Set([
  "J1 coupler_J1 coupler",
  "Z-axis Bottom Plate_Z-axis Bottom Plate",
  "Base cover_Base cover",
  "Top cover_Top cover",
  "Z-axis Top Plate_Z-axis Top Plate",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm001",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm002",
  "Smooth Rod D10mm L400mm_Smooth Rod D10mm L400mm003",
]);
const zAxisParts = new Set([
  "brazodelcontrapeso_Arm 1",
  "tapa_brazo_contrapeso_Arm 1 Cover",
  "Stepper NEMA 17 -  20mm shaft_Stepper NEMA 17 -  20mm shaft002",
  "Z-axis Mount Platform_Z-axis Mount Platform",
  "Arm 1_Arm 1",
  "Arm 1 Cover_Arm 1 Cover",
  "soporte_rodamiento_6mm",
  "flat head screw_am_B18.6.7M - M6 x 1.0 x 50 Type I Cross Recessed FHMS --50C",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm001",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm002",
  "Linear Bearing 10x19x29mm_Linear Bearing 10x19x29mm003",
]);
const yAxisParts = new Set([
  "J2 Coupler_J2 Coupler",
  "Arm 2_Arm 2",
  "Arm 2 Cover_Arm 2 Cover",
  "NEMA 17 Stepper L24mm - 20mm shaft_NEMA 17 Stepper L24mm - 20mm shaft",
]);
const wAxisParts = new Set([
  "J3 Coupler_J3 Coupler",
  "ba_glipper",
  "User Library-MG996R",
]);
const normalizePartName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const xOnlyPartKeys = new Set([...xOnlyParts].map(normalizePartName));
const zAxisPartKeys = new Set([...zAxisParts].map(normalizePartName));
const yAxisPartKeys = new Set([...yAxisParts].map(normalizePartName));
const wAxisPartKeys = new Set([...wAxisParts].map(normalizePartName));
const fallbackStatus: MachineStatus = {
  ok: true,
  type: "status",
  axes: {
    X: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 714, limit: false },
    Y: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 714, limit: false },
    Z: { homed: false, steps: 0, unit: "mm", pos: 0, speed_sps: 714, limit: false },
    W: { homed: false, steps: 0, unit: "deg", pos: 0, speed_sps: 556, limit: false },
  },
  gripper: {
    ready: false,
    state: "open",
    user_angle: 80,
    physical_angle: 170,
    open_user_angle: 80,
    close_user_angle: -90,
  },
  drivers_enabled: false,
};

function statusPose(status: MachineStatus): AxisPose {
  return {
    X: status.axes.X.pos,
    Y: status.axes.Y.pos,
    Z: status.axes.Z.pos,
    W: status.axes.W.pos,
  };
}

function queueModelRender(viewer: RobotViewer) {
  const scene = Object.getOwnPropertySymbols(viewer)
    .map((symbol) => (viewer as unknown as Record<symbol, { queueRender?: () => void }>)[symbol])
    .find((value) => typeof value?.queueRender === "function");
  scene?.queueRender?.();
}

function localPivot(child: Vector3, parent: Vector3) {
  return new Vector3(child.x - parent.x, child.y - parent.y, child.z - parent.z);
}

function setupRobotRig(viewer: RobotViewer): Rig | null {
  const existing = robotRigs.get(viewer);
  if (existing) return existing;

  const firstMesh = viewer.model?.[$primitivesList]?.[0]?.mesh;
  const root = firstMesh?.parent?.parent ?? firstMesh?.parent;
  if (!root?.add || !viewer.model?.[$primitivesList]) return null;

  const x = new Group();
  const z = new Group();
  const y = new Group();
  const w = new Group();
  x.name = "sim_X_base";
  z.name = "sim_Z_lift";
  y.name = "sim_Y_link";
  w.name = "sim_W_wrist";
  x.position.copy(robotPivots.x);
  z.position.copy(new Vector3(0, 0, 0));
  y.position.copy(localPivot(robotPivots.y, robotPivots.x));
  w.position.copy(localPivot(robotPivots.w, robotPivots.y));

  root.add(x);
  x.add(z);
  z.add(y);
  y.add(w);

  let xParts = 0;
  let zParts = 0;
  let yParts = 0;
  let wParts = 0;
  const attached = new Set();
  const jawParts: SceneObject[] = [];
  for (const { mesh } of viewer.model[$primitivesList]) {
    const part = mesh.parent ?? mesh;
    const name = part.name || "";
    const primitiveName = mesh.name || "";
    const normalizedNames = `${normalizePartName(name)} ${normalizePartName(primitiveName)}`;
    const key = normalizePartName(name);
    const primitiveKey = normalizePartName(primitiveName);
    const isJaw = key === "jaw" || key === "jaw001" || primitiveKey === "jaw" || primitiveKey === "jaw001";
    if (attached.has(part)) continue;
    if (wAxisPartKeys.has(key) || wAxisPartKeys.has(primitiveKey) || /basestep|rackstep|spurgear|jaw/.test(normalizedNames)) {
      w.attach(part);
      wParts += 1;
    } else if (yAxisPartKeys.has(key) || yAxisPartKeys.has(primitiveKey)) {
      y.attach(part);
      yParts += 1;
    } else if (zAxisPartKeys.has(key) || zAxisPartKeys.has(primitiveKey)) {
      z.attach(part);
      zParts += 1;
    } else if (xOnlyPartKeys.has(key) || xOnlyPartKeys.has(primitiveKey)) {
      x.attach(part);
      xParts += 1;
    } else {
      continue;
    }
    attached.add(part);
    if (isJaw) jawParts.push(part);
  }

  const jawCenter = jawParts.reduce((center, part) => center.add(part.position), new Vector3()).multiplyScalar(jawParts.length ? 1 / jawParts.length : 0);
  const jaws = jawParts.map((part) => {
    const open = part.position.clone();
    const close = open.clone().add(jawCenter.clone().sub(open).setLength(gripperCloseTravelM));
    return { part, open, close };
  });
  viewer.dataset.rigged = "true";
  viewer.dataset.xParts = String(xParts);
  viewer.dataset.zParts = String(zParts);
  viewer.dataset.yParts = String(yParts);
  viewer.dataset.wParts = String(wParts);
  const rig = { x, y, z, w, jaws };
  robotRigs.set(viewer, rig);
  return rig;
}

function applyRobotPose(viewer: RobotViewer | null, pose: AxisPose, gripper: GripperPose = "open") {
  if (!viewer) return;
  const rig = setupRobotRig(viewer);
  if (!rig) return;
  rig.x.rotation.z = MathUtils.degToRad(pose.X);
  rig.y.rotation.z = MathUtils.degToRad(pose.Y);
  rig.z.position.z = (zAxisBaseOffsetMm - pose.Z) / 1000;
  rig.w.rotation.z = MathUtils.degToRad(pose.W);
  for (const jaw of rig.jaws) jaw.part.position.copy(gripper === "close" ? jaw.close : jaw.open);
  viewer.dataset.poseX = String(pose.X);
  viewer.dataset.poseY = String(pose.Y);
  viewer.dataset.poseZ = String(pose.Z);
  viewer.dataset.poseW = String(pose.W);
  viewer.dataset.gripper = gripper;
  queueModelRender(viewer);
}

function formatConnectionError(error: unknown) {
  const message = String(error);
  if (/access is denied|acceso denegado|os error 5/i.test(message)) {
    return "Acceso denegado al puerto serial. Cierra Arduino IDE/Serial Monitor/u otra HMI que este usando ese COM, desconecta y conecta el USB, y vuelve a intentar.";
  }
  return message;
}

function isStatus(value: unknown): value is MachineStatus {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { ok?: unknown }).ok === true &&
      (value as { type?: unknown }).type === "status" &&
      (value as { axes?: unknown }).axes,
  );
}

function isHeartbeatLog(entry: SerialEvent) {
  return (entry.direction === "tx" && entry.line === "PING") || (entry.direction === "rx" && entry.line === '{"ok":true,"type":"pong"}');
}

function App() {
  const [view, setView] = useState<View>("home");
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<MachineStatus>(fallbackStatus);
  const [logs, setLogs] = useState<SerialEvent[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [logoHidden, setLogoHidden] = useState(false);
  const [baudRate, setBaudRate] = useState<BaudRate>(115200);
  const [manualCommand, setManualCommand] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState("");
  const connectedRef = useRef(false);
  const lastRxAt = useRef(Date.now());

  const disabled = !connected || busy;

  function logError(error: unknown) {
    const message = formatConnectionError(error);
    setConnectionError(message);
    setLogs((items) => [{ direction: "error", line: message, timestamp: Date.now() }, ...items]);
  }

  async function refreshPorts() {
    setConnectionError("");
    if (!("__TAURI_INTERNALS__" in window)) {
      throw new Error("Abre la app de Tauri, no la pagina de Vite en el navegador.");
    }
    const names = await invoke<string[]>("list_ports");
    setPorts(names);
    setPort((current) => (names.includes(current) ? current : names[0] || current));
    if (names.length === 0) {
      setConnectionError("No se detectaron puertos. Si Arduino IDE muestra uno, escribelo manualmente, por ejemplo COM4.");
    }
  }

  async function sendCommand(command: string, waitsForStatus = true) {
    if (!connected || busy) return;
    if (waitsForStatus) setBusy(true);
    try {
      await invoke("send_command", { command });
    } catch (error) {
      setBusy(false);
      logError(error);
    }
  }

  async function connect() {
    if (!port) return;
    setConnectionError("");
    await invoke("connect", { portName: port, baudRate }).catch((error) => {
      throw new Error(formatConnectionError(error));
    });
    lastRxAt.current = Date.now();
    connectedRef.current = true;
    setConnected(true);
    await invoke("send_command", { command: "PING" });
    await invoke("send_command", { command: "STATUS" });
  }

  async function disconnect() {
    await invoke("disconnect");
    connectedRef.current = false;
    setConnected(false);
    setBusy(false);
  }

  async function checkForUpdate() {
    if (!("__TAURI_INTERNALS__" in window)) return;
    try {
      setUpdate(await check());
    } catch {
      setUpdate(null);
    }
  }

  async function installUpdate() {
    if (!update) return;
    setUpdateBusy(true);
    setUpdateMessage("Preparando actualizacion...");
    try {
      let totalBytes = 0;
      let downloadedBytes = 0;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength || 0;
          downloadedBytes = 0;
          setUpdateMessage("Descargando actualizacion...");
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdateMessage(totalBytes ? `Descargando ${Math.round((downloadedBytes / totalBytes) * 100)}%...` : "Descargando actualizacion...");
        } else {
          setUpdateMessage("Instalando y reiniciando...");
        }
      });
      await relaunch();
    } catch (error) {
      setUpdateBusy(false);
      setUpdateMessage("No se pudo instalar la actualizacion.");
      logError(error);
    }
  }

  useEffect(() => {
    const isTauri = "__TAURI_INTERNALS__" in window;
    if (isTauri) refreshPorts().catch(logError);
    checkForUpdate();

    const unlisten = isTauri ? listen<SerialEvent>("serial-event", (event) => {
      const entry = event.payload;
      if (!isHeartbeatLog(entry)) {
        setLogs((items) => [entry, ...items].slice(0, 300));
      }

      if (entry.direction === "error" && connectedRef.current) {
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError(`Conexion serial perdida: ${entry.line}`);
        return;
      }

      if (entry.direction !== "rx") return;
      lastRxAt.current = Date.now();

      try {
        const parsed: unknown = JSON.parse(entry.line);
        if (isStatus(parsed)) {
          setStatus(parsed);
          setBusy(false);
        } else if ((parsed as { ok?: boolean }).ok === false) {
          setBusy(false);
        }
      } catch {
        setLogs((items) => [{ direction: "error" as const, line: `JSON invalido: ${entry.line}`, timestamp: Date.now() }, ...items].slice(0, 300));
      }
    }) : Promise.resolve(() => undefined);

    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
    if (!connected) return;

    const timer = window.setInterval(async () => {
      if (busy) return;

      if (Date.now() - lastRxAt.current > 6000) {
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError("Conexion serial perdida: no responde PING.");
        await invoke("disconnect").catch(() => undefined);
        return;
      }

      try {
        await invoke("send_command", { command: "PING" });
      } catch (error) {
        connectedRef.current = false;
        setConnected(false);
        setBusy(false);
        setConnectionError(`Conexion serial perdida: ${String(error)}`);
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [connected, busy]);

  const serialConsole = (
    <SerialConsole
      open={consoleOpen}
      logs={logs}
      command={manualCommand}
      disabled={disabled}
      onToggle={() => setConsoleOpen((value) => !value)}
      onCommandChange={setManualCommand}
      onSubmit={() => {
        const command = manualCommand.trim().toUpperCase();
        if (command) sendCommand(command);
        setManualCommand("");
      }}
    />
  );

  return (
    <main className="appShell">
      <aside className="sideRail">
        <div className="appBrand">
          <p><span>HMI</span> <strong>Rotty</strong></p>
          <small>BRAZO SCADA</small>
        </div>

        <nav className="navTabs" aria-label="Menu principal">
          <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
            <span className="navIcon">⌂</span>
            <span>Home</span>
          </button>
          <button className={view === "control" ? "active" : ""} onClick={() => setView("control")}>
            <span className="navIcon">⚙</span>
            <span>Control</span>
          </button>
          <button disabled><span className="navIcon">⤴</span><span>Trayectorias</span></button>
        </nav>

        <LogoBlock hidden={logoHidden} onToggle={() => setLogoHidden((value) => !value)} />
      </aside>

      <section className="screen">
        <header className="topBar">
          <div>
            <p className="sectionKicker">{view === "home" ? "Panel principal" : "Movimiento manual"}</p>
            <h2>{view === "home" ? "Home" : "Control"}</h2>
          </div>
          {update && (
            <div className="updateBox" role="status" aria-live="polite">
              <button
                className="updateButton"
                onClick={installUpdate}
                disabled={updateBusy}
                title={`Actualizacion disponible: ${update.version}. Descargar e instalar.`}
                aria-label={`Descargar e instalar actualizacion ${update.version}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v11" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M5 20h14" />
                </svg>
                <span>{updateBusy ? "Actualizando" : `Actualizar ${update.version}`}</span>
              </button>
              {updateMessage && <small>{updateMessage}</small>}
            </div>
          )}
        </header>

        {view === "home" ? (
          <HomeView
            port={port}
            ports={ports}
            connected={connected}
            busy={busy}
            status={status}
            baudRate={baudRate}
            connectionError={connectionError}
            onPortChange={setPort}
            onBaudRateChange={setBaudRate}
            onRefreshPorts={() => refreshPorts().catch(logError)}
            onConnect={() => connect().catch(logError)}
            onDisconnect={() => disconnect().catch(logError)}
            onCommand={sendCommand}
          />
        ) : (
          <ControlView status={status} connected={connected} disabled={disabled} onCommand={sendCommand} consolePanel={serialConsole} />
        )}

        {view === "home" && serialConsole}
      </section>
    </main>
  );
}

function HomeView({
  port,
  ports,
  connected,
  busy,
  status,
  baudRate,
  connectionError,
  onPortChange,
  onBaudRateChange,
  onRefreshPorts,
  onConnect,
  onDisconnect,
  onCommand,
}: {
  port: string;
  ports: string[];
  connected: boolean;
  busy: boolean;
  status: MachineStatus;
  baudRate: BaudRate;
  connectionError: string;
  onPortChange: (value: string) => void;
  onBaudRateChange: (value: BaudRate) => void;
  onRefreshPorts: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onCommand: SendCommand;
}) {
  const disabled = !connected || busy;

  return (
    <div className="homeGrid">
      <aside className="leftStack">
        <section className="quickPanel homeCommands">
          <button className="heroAction" onClick={() => onCommand("HOME ALL")} disabled={disabled}>
            HOME ALL
          </button>
          <button onClick={() => onCommand("STATUS")} disabled={disabled}>
            STATUS
          </button>
        </section>
        <SystemPanel status={status} />
      </aside>

      <RobotStage status={status} />

      <aside className="rightStack">
        <ConnectionPanel
          port={port}
          ports={ports}
          connected={connected}
          busy={busy}
          baudRate={baudRate}
          connectionError={connectionError}
          onPortChange={onPortChange}
          onBaudRateChange={onBaudRateChange}
          onRefreshPorts={onRefreshPorts}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
        <section className="quickPanel">
          <h3>Acciones rapidas</h3>
          <Metric label="Drivers" value={status.drivers_enabled ? "Habilitados" : "Deshabilitados"} />
          <button className="motorLock" onClick={() => onCommand("ENABLE")} disabled={disabled}>
            Habilitar Motores
          </button>
          <button className="enable" onClick={() => onCommand("DISABLE")} disabled={disabled}>
            Deshabilitar Motores
          </button>
        </section>
      </aside>
    </div>
  );
}

function ControlView({
  status,
  connected,
  disabled,
  onCommand,
  consolePanel,
}: {
  status: MachineStatus;
  connected: boolean;
  disabled: boolean;
  onCommand: SendCommand;
  consolePanel: ReactNode;
}) {
  const [pose, setPose] = useState<AxisPose>(() => statusPose(status));
  const [gripper, setGripper] = useState<GripperPose>(status.gripper?.state === "close" ? "close" : "open");

  useEffect(() => {
    setPose(statusPose(status));
    setGripper(status.gripper?.state === "close" ? "close" : "open");
  }, [status]);

  function previewGripper(next: GripperPose) {
    setGripper(next);
    if (!disabled) onCommand(`GRIPPER ${next.toUpperCase()}`);
  }

  return (
    <div className="controlGrid">
      <div className="controlCenter">
        <RobotStage status={status} pose={pose} gripper={gripper} compact />
        <div className={`controlStatePill ${connected ? "online" : ""}`}>
          <span />
          {connected ? "Conectado" : "Desconectado"}
        </div>
        {consolePanel}
      </div>
      <aside className="controlSide">
        <GripperCard onPreview={previewGripper} />
        <section className="axisStack">
          {axes.map((name) => (
            <AxisCard
              key={name}
              name={name}
              axis={status.axes[name]}
              previewValue={pose[name]}
              disabled={disabled}
              onPreviewChange={(value) => setPose((current) => ({ ...current, [name]: value }))}
              onCommand={onCommand}
            />
          ))}
        </section>
      </aside>
    </div>
  );
}

function ConnectionPanel({
  port,
  ports,
  connected,
  busy,
  baudRate,
  connectionError,
  onPortChange,
  onBaudRateChange,
  onRefreshPorts,
  onConnect,
  onDisconnect,
}: {
  port: string;
  ports: string[];
  connected: boolean;
  busy: boolean;
  baudRate: BaudRate;
  connectionError: string;
  onPortChange: (value: string) => void;
  onBaudRateChange: (value: BaudRate) => void;
  onRefreshPorts: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const machineState = !connected ? "Desconectado" : busy ? "Ejecutando" : "Conectado";
  const selectedPort = ports.includes(port) ? port : "__manual";

  return (
    <section className="panel connectionPanel">
      <div className={`statusPill ${connected ? "online" : ""}`}>
        <span />
        {machineState}
      </div>
      <h3>Conexion</h3>
      <label>
        Puerto serial
        <select value={selectedPort} onChange={(event) => event.target.value !== "__manual" && onPortChange(event.target.value)} disabled={connected}>
          {ports.length === 0 && <option value="__manual">Sin puertos detectados</option>}
          {ports.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value="__manual">Escribir manualmente</option>
        </select>
      </label>
      {selectedPort === "__manual" && (
        <label>
          COM manual
          <input value={port} onChange={(event) => onPortChange(event.target.value.toUpperCase())} disabled={connected} placeholder="COM4" />
        </label>
      )}
      {connectionError && (
        <div className="connectionError" role="alert">
          <strong>Aviso de conexion</strong>
          <span>{connectionError}</span>
        </div>
      )}
      <div className="splitButtons">
        <button onClick={onRefreshPorts} disabled={connected}>
          Actualizar
        </button>
        <button className="primary" onClick={connected ? onDisconnect : onConnect} disabled={!connected && !port}>
          {connected ? "Desconectar" : "Conectar"}
        </button>
      </div>
      <label>
        BaudRate
        <select
          value={baudRate}
          onChange={(event) => onBaudRateChange(Number(event.target.value) as BaudRate)}
          disabled={connected}
        >
          <option value={115200}>115200</option>
        </select>
      </label>
    </section>
  );
}

function SystemPanel({ status }: { status: MachineStatus }) {
  const rows = [
    ["Eje X", status.axes.X.limit],
    ["Eje Y", status.axes.Y.limit],
    ["Eje Z", status.axes.Z.limit],
    ["Muneca", status.axes.W.limit],
  ] as const;

  return (
    <section className="panel">
      <h3>Estado del sistema</h3>
      <div className="axisLights">
        {rows.map(([label, limit]) => (
          <div key={label}>
            <span>{label}</span>
            <b className={limit ? "bad" : "ok"} />
          </div>
        ))}
      </div>
    </section>
  );
}

function RobotStage({
  status,
  pose = statusPose(status),
  gripper = status.gripper?.state === "close" ? "close" : "open",
  compact = false,
  children,
}: {
  status: MachineStatus;
  pose?: AxisPose;
  gripper?: GripperPose;
  compact?: boolean;
  children?: ReactNode;
}) {
  const viewerRef = useRef<RobotViewer | null>(null);

  useEffect(() => {
    applyRobotPose(viewerRef.current, pose, gripper);
  }, [pose, gripper]);

  return (
    <section className={compact ? "robotStage compact" : "robotStage"} aria-label="Vista 3D del brazo">
      <model-viewer
        ref={viewerRef}
        className="modelSlot"
        src="/robot.gltf?v=20260702-v3"
        onLoad={() => applyRobotPose(viewerRef.current, pose, gripper)}
        camera-controls
        disable-zoom
        disable-tap
        interaction-prompt="none"
        orientation="0deg 90deg 0deg"
        camera-orbit="35deg 68deg 92%"
        min-camera-orbit="auto auto 92%"
        max-camera-orbit="auto auto 92%"
        camera-target="0m 0m 0m"
        field-of-view="24deg"
        min-field-of-view="24deg"
        max-field-of-view="24deg"
        shadow-intensity="0.7"
        exposure="1"
        alt="Modelo 3D del brazo SCARA"
      />
      <div className="positionPanel">
        <h3>Posicion actual</h3>
        <Metric label="X" value={`${status.axes.X.pos.toFixed(2)} deg`} />
        <Metric label="Y" value={`${status.axes.Y.pos.toFixed(2)} deg`} />
        <Metric label="Z" value={`${status.axes.Z.pos.toFixed(2)} mm`} />
        <Metric label="W" value={`${status.axes.W.pos.toFixed(2)} deg`} />
        {children && <div className="positionActions">{children}</div>}
      </div>
    </section>
  );
}

function AxisCard({
  name,
  axis,
  previewValue,
  disabled,
  onPreviewChange,
  onCommand,
}: {
  name: AxisName;
  axis: AxisStatus;
  previewValue: number;
  disabled: boolean;
  onPreviewChange: (value: number) => void;
  onCommand: SendCommand;
}) {
  const [value, setValue] = useState(String(previewValue));
  const unit = name === "Z" ? "MM" : "DEG";
  const speedSps = axis.speed_sps || axis.speed_us || 700;
  const min = name === "Z" ? 0 : -90;
  const max = name === "Z" ? zAxisTravelMm : 90;
  const clampedValue = Math.min(max, Math.max(min, Number(value) || 0));

  useEffect(() => {
    setValue(String(previewValue));
  }, [previewValue]);

  function updateValue(next: string) {
    setValue(next);
    onPreviewChange(Math.min(max, Math.max(min, Number(next) || 0)));
  }

  return (
    <article className="axisCard">
      <div className="axisHeader">
        <div>
          <p>Eje {name}</p>
          <h3>
            {axis.pos.toFixed(2)} {axis.unit}
          </h3>
        </div>
        <span className={axis.homed ? "badge good" : "badge warn"}>{axis.homed ? "Homed" : "Sin home"}</span>
      </div>
      <p className="axisSpeed">Velocidad {speedSps} pasos/s</p>

      <input
        aria-label={`Movimiento eje ${name}`}
        type="range"
        min={min}
        max={max}
        value={clampedValue}
        onChange={(event) => updateValue(event.target.value)}
      />

      <div className="axisInputs">
        <label>
          {name === "Z" ? "Altura mm" : "Grados"}
          <input min={min} max={max} type="number" value={value} onChange={(event) => updateValue(event.target.value)} />
        </label>
      </div>

      <div className="splitButtons">
        <button onClick={() => onCommand(`HOME ${name}`)} disabled={disabled}>
          HOME
        </button>
        <button
          className="primary"
          onClick={() => onCommand(`MOVE ${name} ${unit} ${clampedValue}`)}
          disabled={disabled}
        >
          MOVE
        </button>
      </div>
    </article>
  );
}

function GripperCard({
  onPreview,
}: {
  onPreview: (state: GripperPose) => void;
}) {
  return (
    <article className="axisCard gripperCard">
      <div className="axisHeader">
        <div>
          <p>Pinza</p>
        </div>
      </div>
      <div className="splitButtons">
        <button className="primary" onClick={() => onPreview("open")}>
          Abrir
        </button>
        <button onClick={() => onPreview("close")}>
          Cerrar
        </button>
      </div>
    </article>
  );
}

function SerialConsole({
  open,
  logs,
  command,
  disabled,
  onToggle,
  onCommandChange,
  onSubmit,
}: {
  open: boolean;
  logs: SerialEvent[];
  command: string;
  disabled: boolean;
  onToggle: () => void;
  onCommandChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className="consolePanel">
      <button className="consoleToggle" onClick={onToggle}>
        Consola serial {open ? "ocultar" : "mostrar"}
      </button>
      {open && (
        <>
          <form
            className="manual"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <input
              value={command}
              onChange={(event) => onCommandChange(event.target.value)}
              placeholder="PING, STATUS, MOVE X DEG 10..."
              disabled={disabled}
            />
            <button disabled={disabled}>Enviar</button>
          </form>
          <div className="console" aria-live="polite">
            {logs.map((entry, index) => (
              <code key={`${entry.timestamp}-${index}`} className={entry.direction}>
                {new Date(entry.timestamp).toLocaleTimeString()} [{entry.direction}] {entry.line}
              </code>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LogoBlock({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  return (
    <div className={hidden ? "brandMark hidden" : "brandMark"}>
      {!hidden && (
        <>
          <img src={dmLogo} alt="D&M Robotics" />
        </>
      )}
      <button onClick={onToggle}>{hidden ? "Mostrar logo" : "Ocultar logo"}</button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

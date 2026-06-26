import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import "@google/model-viewer";
import dmLogo from "./assets/brand/dm-logo.png";
import "./styles.css";

type AxisName = "X" | "Y" | "Z" | "W";
type BaudRate = 115200;
type View = "home" | "control";
type SendCommand = (command: string, waitsForStatus?: boolean) => void | Promise<void>;

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
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (error) {
      setUpdateBusy(false);
      logError(error);
    }
  }

  useEffect(() => {
    refreshPorts().catch(logError);
    checkForUpdate();

    const unlisten = listen<SerialEvent>("serial-event", (event) => {
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
    });

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
            <button
              className="updateButton"
              onClick={installUpdate}
              disabled={updateBusy}
              title={`Actualizacion disponible: ${update.version}. Descargar e instalar.`}
              aria-label={`Actualizacion disponible: ${update.version}`}
            >
              {updateBusy ? "..." : "↓"}
            </button>
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
          <ControlView status={status} disabled={disabled} onCommand={sendCommand} consolePanel={serialConsole} />
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
  disabled,
  onCommand,
  consolePanel,
}: {
  status: MachineStatus;
  disabled: boolean;
  onCommand: SendCommand;
  consolePanel: ReactNode;
}) {
  return (
    <div className="controlGrid">
      <div className="controlCenter">
        <RobotStage status={status} compact>
          <GripperCard gripper={status.gripper} disabled={disabled} onCommand={onCommand} />
        </RobotStage>
        {consolePanel}
      </div>
      <section className="axisStack">
        {axes.map((name) => (
          <AxisCard key={name} name={name} axis={status.axes[name]} disabled={disabled} onCommand={onCommand} />
        ))}
      </section>
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

function RobotStage({ status, compact = false, children }: { status: MachineStatus; compact?: boolean; children?: ReactNode }) {
  return (
    <section className={compact ? "robotStage compact" : "robotStage"} aria-label="Vista 3D del brazo">
      <model-viewer
        className="modelSlot"
        src="/robot.gltf"
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
  disabled,
  onCommand,
}: {
  name: AxisName;
  axis: AxisStatus;
  disabled: boolean;
  onCommand: SendCommand;
}) {
  const [value, setValue] = useState("0");
  const unit = name === "Z" ? "MM" : "DEG";
  const speedSps = axis.speed_sps || axis.speed_us || 700;
  const min = name === "Z" ? -20 : -90;
  const max = name === "Z" ? 20 : 90;
  const clampedValue = Math.min(max, Math.max(min, Number(value) || 0));

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
        onChange={(event) => setValue(event.target.value)}
      />

      <div className="axisInputs">
        <label>
          {name === "Z" ? "Altura mm" : "Grados"}
          <input min={min} max={max} type="number" value={value} onChange={(event) => setValue(event.target.value)} />
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
  gripper,
  disabled,
  onCommand,
}: {
  gripper: MachineStatus["gripper"];
  disabled: boolean;
  onCommand: SendCommand;
}) {
  return (
    <article className="axisCard gripperCard">
      <div className="axisHeader">
        <div>
          <p>Pinza</p>
          <h3>{gripper ? `${gripper.user_angle} deg` : "sin dato"}</h3>
        </div>
        <span className={gripper?.ready ? "badge good" : "badge warn"}>{gripper?.state ?? "Sin dato"}</span>
      </div>
      <div className="splitButtons">
        <button onClick={() => onCommand("GRIPPER OPEN")} disabled={disabled}>
          Abrir
        </button>
        <button className="primary" onClick={() => onCommand("GRIPPER CLOSE")} disabled={disabled}>
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

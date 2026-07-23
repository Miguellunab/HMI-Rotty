use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            CreateMutexW, CreateProcessW, ReleaseMutex, ResumeThread, TerminateProcess,
            WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_INFORMATION,
            STARTUPINFOW,
        },
    },
};

const VISION_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const VISION_POLL_INTERVAL: Duration = Duration::from_millis(400);
const VISION_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

struct SerialState {
    port: Option<Box<dyn SerialPort>>,
    connected: bool,
    session: u64,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum VisionPhase {
    Preparing,
    Ready,
    StartingCamera,
    Running,
    StoppingCamera,
    Error,
}

struct VisionState {
    process: Option<ManagedVisionProcess>,
    owned: bool,
    service_detected: bool,
    phase: VisionPhase,
    started_at: Option<Instant>,
    detail: Option<String>,
    camera_requested: bool,
    stop_requested: bool,
    camera_generation: u64,
    start_sent_generation: Option<u64>,
    stop_sent_generation: Option<u64>,
    worker_running: bool,
    retry_requested: bool,
    action_in_progress: bool,
    closing: bool,
}

impl VisionState {
    fn new() -> Self {
        Self {
            process: None,
            owned: false,
            service_detected: false,
            phase: VisionPhase::Preparing,
            started_at: None,
            detail: None,
            camera_requested: false,
            stop_requested: false,
            camera_generation: 0,
            start_sent_generation: None,
            stop_sent_generation: None,
            worker_running: false,
            retry_requested: false,
            action_in_progress: false,
            closing: false,
        }
    }
}

#[cfg(windows)]
struct VisionLaunchLock(HANDLE);

#[cfg(windows)]
unsafe impl Send for VisionLaunchLock {}

#[cfg(windows)]
impl Drop for VisionLaunchLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
struct ManagedVisionProcess {
    job: HANDLE,
    process: HANDLE,
    _launch_lock: VisionLaunchLock,
}

#[cfg(windows)]
unsafe impl Send for ManagedVisionProcess {}

#[cfg(windows)]
impl ManagedVisionProcess {
    fn is_running(&self) -> bool {
        unsafe { WaitForSingleObject(self.process, 0) != 0 }
    }

    fn wait(&self, timeout: Duration) -> bool {
        let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        unsafe { WaitForSingleObject(self.process, timeout_ms) == 0 }
    }

    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ManagedVisionProcess {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.process);
            CloseHandle(self.job);
        }
    }
}

#[derive(Deserialize)]
struct VisionHealth {
    status: String,
    camera_active: bool,
    message: Option<String>,
}

enum VisionHealthState {
    Ready,
    Starting,
    Running,
    Stopping,
    Error(String),
}

#[derive(Serialize)]
struct VisionStatus {
    status: VisionPhase,
    external: bool,
    detail: Option<String>,
}

impl From<&VisionState> for VisionStatus {
    fn from(state: &VisionState) -> Self {
        Self {
            status: state.phase,
            external: state.service_detected && !state.owned,
            detail: state.detail.clone(),
        }
    }
}

#[derive(Serialize, Clone)]
struct SerialLine {
    direction: String,
    line: String,
    timestamp: u128,
}

#[derive(Deserialize)]
struct PositionInput {
    name: String,
    x: f64,
    y: f64,
    z: f64,
    w: f64,
    gripper: String,
}

#[derive(Serialize)]
struct SavedPosition {
    id: i64,
    name: String,
    x: f64,
    y: f64,
    z: f64,
    w: f64,
    gripper: String,
    created_at: i64,
}

#[derive(Deserialize)]
struct TrajectoryStepInput {
    kind: String,
    position_id: Option<i64>,
    gripper: Option<String>,
    delay_ms: Option<i64>,
    command: Option<String>,
}

#[derive(Deserialize)]
struct TrajectoryInput {
    id: Option<i64>,
    name: String,
    steps: Vec<TrajectoryStepInput>,
}

#[derive(Serialize)]
struct TrajectoryStep {
    id: i64,
    sort_index: i64,
    kind: String,
    position_id: Option<i64>,
    gripper: Option<String>,
    delay_ms: Option<i64>,
    command: Option<String>,
}

#[derive(Serialize)]
struct SavedTrajectory {
    id: i64,
    name: String,
    created_at: i64,
    steps: Vec<TrajectoryStep>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn emit_line(app: &tauri::AppHandle, direction: &str, line: impl Into<String>) {
    let _ = app.emit(
        "serial-event",
        SerialLine {
            direction: direction.to_string(),
            line: line.into(),
            timestamp: now_ms(),
        },
    );
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("trajectories.sqlite3"))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(db_path(app)?).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                x REAL NOT NULL,
                y REAL NOT NULL,
                z REAL NOT NULL,
                w REAL NOT NULL,
                gripper TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trajectories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trajectory_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trajectory_id INTEGER NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
                sort_index INTEGER NOT NULL,
                kind TEXT NOT NULL,
                position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
                gripper TEXT,
                delay_ms INTEGER,
                command TEXT
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn clean_name(name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("NAME_REQUIRED".into());
    }
    Ok(name.chars().take(80).collect())
}

fn clean_gripper(value: String) -> Result<String, String> {
    let value = value.trim().to_lowercase();
    if value == "open" || value == "close" {
        Ok(value)
    } else {
        Err("INVALID_GRIPPER".into())
    }
}

fn validate_step(step: &TrajectoryStepInput) -> Result<(), String> {
    match step.kind.as_str() {
        "position" if step.position_id.is_some() => Ok(()),
        "gripper" => clean_gripper(step.gripper.clone().unwrap_or_default()).map(|_| ()),
        "wait" if step.delay_ms.unwrap_or(-1) >= 0 => Ok(()),
        "home" if step.command.as_deref().unwrap_or("HOME ALL") == "HOME ALL" => Ok(()),
        _ => Err("INVALID_TRAJECTORY_STEP".into()),
    }
}

#[tauri::command]
fn list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_position(app: AppHandle, input: PositionInput) -> Result<SavedPosition, String> {
    let connection = open_db(&app)?;
    let name = clean_name(input.name)?;
    let gripper = clean_gripper(input.gripper)?;
    let created_at = now_seconds();
    connection
        .execute(
            "INSERT INTO positions (name, x, y, z, w, gripper, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![name, input.x, input.y, input.z, input.w, gripper, created_at],
        )
        .map_err(|error| error.to_string())?;
    let id = connection.last_insert_rowid();
    Ok(SavedPosition {
        id,
        name,
        x: input.x,
        y: input.y,
        z: input.z,
        w: input.w,
        gripper,
        created_at,
    })
}

#[tauri::command]
fn list_positions(app: AppHandle) -> Result<Vec<SavedPosition>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection
        .prepare("SELECT id, name, x, y, z, w, gripper, created_at FROM positions ORDER BY created_at ASC, id ASC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(SavedPosition {
                id: row.get(0)?,
                name: row.get(1)?,
                x: row.get(2)?,
                y: row.get(3)?,
                z: row.get(4)?,
                w: row.get(5)?,
                gripper: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_position(app: AppHandle, id: i64) -> Result<(), String> {
    let connection = open_db(&app)?;
    connection
        .execute("DELETE FROM positions WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_trajectory(app: AppHandle, input: TrajectoryInput) -> Result<SavedTrajectory, String> {
    let mut connection = open_db(&app)?;
    let name = clean_name(input.name)?;
    for step in &input.steps {
        validate_step(step)?;
    }

    let created_at = now_seconds();
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let id = if let Some(id) = input.id {
        tx.execute(
            "UPDATE trajectories SET name = ?1 WHERE id = ?2",
            params![name, id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM trajectory_steps WHERE trajectory_id = ?1",
            params![id],
        )
        .map_err(|error| error.to_string())?;
        id
    } else {
        tx.execute(
            "INSERT INTO trajectories (name, created_at) VALUES (?1, ?2)",
            params![name, created_at],
        )
        .map_err(|error| error.to_string())?;
        tx.last_insert_rowid()
    };

    for (index, step) in input.steps.iter().enumerate() {
        let gripper = step.gripper.clone().map(clean_gripper).transpose()?;
        let command = if step.kind == "home" {
            Some("HOME ALL".to_string())
        } else {
            step.command.clone()
        };
        tx.execute(
            "INSERT INTO trajectory_steps (trajectory_id, sort_index, kind, position_id, gripper, delay_ms, command) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, index as i64, step.kind, step.position_id, gripper, step.delay_ms, command],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;

    list_trajectories(app)?
        .into_iter()
        .find(|trajectory| trajectory.id == id)
        .ok_or("TRAJECTORY_NOT_FOUND".into())
}

#[tauri::command]
fn list_trajectories(app: AppHandle) -> Result<Vec<SavedTrajectory>, String> {
    let connection = open_db(&app)?;
    let mut statement = connection
        .prepare("SELECT id, name, created_at FROM trajectories ORDER BY created_at DESC, id DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(SavedTrajectory {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                steps: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    let mut trajectories = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for trajectory in &mut trajectories {
        let mut steps = connection
            .prepare("SELECT id, sort_index, kind, position_id, gripper, delay_ms, command FROM trajectory_steps WHERE trajectory_id = ?1 ORDER BY sort_index ASC")
            .map_err(|error| error.to_string())?;
        let rows = steps
            .query_map(params![trajectory.id], |row| {
                Ok(TrajectoryStep {
                    id: row.get(0)?,
                    sort_index: row.get(1)?,
                    kind: row.get(2)?,
                    position_id: row.get(3)?,
                    gripper: row.get(4)?,
                    delay_ms: row.get(5)?,
                    command: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?;
        trajectory.steps = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
    }

    Ok(trajectories)
}

#[tauri::command]
fn delete_trajectory(app: AppHandle, id: i64) -> Result<(), String> {
    let connection = open_db(&app)?;
    connection
        .execute("DELETE FROM trajectories WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn connect(
    app: tauri::AppHandle,
    state: State<'_, Mutex<SerialState>>,
    port_name: String,
    baud_rate: u32,
) -> Result<(), String> {
    let port = serialport::new(&port_name, baud_rate)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|error| error.to_string())?;
    let reader = port.try_clone().map_err(|error| error.to_string())?;
    let session = {
        let mut state = state.lock().map_err(|_| "SERIAL_STATE_LOCK_FAILED")?;
        state.session += 1;
        state.connected = true;
        state.port = Some(port);
        state.session
    };

    emit_line(&app, "tx", format!("CONNECTED {port_name} @ {baud_rate}"));
    let app_for_thread = app.clone();

    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();

        loop {
            {
                let serial_state = app_for_thread.state::<Mutex<SerialState>>();
                let state = match serial_state.lock() {
                    Ok(state) => state,
                    Err(_) => break,
                };
                if !state.connected || state.session != session {
                    break;
                }
            }

            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => continue,
                Ok(_) => {
                    let clean = line.trim().to_string();
                    if !clean.is_empty() {
                        emit_line(&app_for_thread, "rx", clean);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(error) => {
                    emit_line(&app_for_thread, "error", error.to_string());
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn disconnect(state: State<'_, Mutex<SerialState>>) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "SERIAL_STATE_LOCK_FAILED")?;
    state.connected = false;
    state.session += 1;
    state.port = None;
    Ok(())
}

#[tauri::command]
fn send_command(
    app: tauri::AppHandle,
    state: State<'_, Mutex<SerialState>>,
    command: String,
) -> Result<(), String> {
    let command = command.trim().to_uppercase();
    if command.is_empty() {
        return Err("EMPTY_COMMAND".into());
    }

    let mut state = state.lock().map_err(|_| "SERIAL_STATE_LOCK_FAILED")?;
    let port = state.port.as_mut().ok_or("SERIAL_NOT_CONNECTED")?;
    port.write_all(command.as_bytes())
        .and_then(|_| port.write_all(b"\n"))
        .and_then(|_| port.flush())
        .map_err(|error| error.to_string())?;
    emit_line(&app, "tx", command);
    Ok(())
}

fn vision_request(method: &str, path: &str) -> Result<String, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], 8765));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350))
        .map_err(|error| error.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return Err("Respuesta HTTP incompleta del servicio de vision.".into());
    };
    if !(headers.starts_with("HTTP/1.0 2") || headers.starts_with("HTTP/1.1 2")) {
        return Err(format!(
            "El servicio de vision respondio {}.",
            headers.lines().next().unwrap_or("con un error HTTP")
        ));
    }
    Ok(body.to_string())
}

fn parse_vision_health(body: &str) -> Result<VisionHealthState, String> {
    let health: VisionHealth = serde_json::from_str(body).map_err(|error| error.to_string())?;
    match (health.status.as_str(), health.camera_active) {
        ("ready", false) => Ok(VisionHealthState::Ready),
        ("starting", false) => Ok(VisionHealthState::Starting),
        ("running", true) => Ok(VisionHealthState::Running),
        ("stopping", _) => Ok(VisionHealthState::Stopping),
        ("error", false) => Ok(VisionHealthState::Error(
            health
                .message
                .unwrap_or_else(|| "El servicio de vision informo un error.".into()),
        )),
        _ => Err(format!(
            "Estado de vision inconsistente: status={}, camera_active={}.",
            health.status, health.camera_active
        )),
    }
}

fn vision_health() -> Result<VisionHealthState, String> {
    parse_vision_health(&vision_request("GET", "/health")?)
}

fn vision_post(path: &str) -> Result<(), String> {
    vision_request("POST", path).map(|_| ())
}

fn vision_status_snapshot(app: &AppHandle) -> Result<VisionStatus, String> {
    let state_handle = app.state::<Mutex<VisionState>>();
    state_handle
        .lock()
        .map(|state| VisionStatus::from(&*state))
        .map_err(|_| "VISION_STATE_LOCK_FAILED".into())
}

#[cfg(windows)]
fn wide_null(value: &Path) -> Vec<u16> {
    value.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn try_acquire_vision_launch_lock() -> Result<Option<VisionLaunchLock>, String> {
    let name = wide_null(Path::new("Local\\HmiRottyVisionDetector"));
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let wait = WaitForSingleObject(handle, 0);
        if wait == 0 || wait == 0x80 {
            Ok(Some(VisionLaunchLock(handle)))
        } else {
            CloseHandle(handle);
            Ok(None)
        }
    }
}

#[cfg(windows)]
fn spawn_managed_vision() -> Result<Option<ManagedVisionProcess>, String> {
    let Some(launch_lock) = try_acquire_vision_launch_lock()? else {
        return Ok(None);
    };
    if vision_health().is_ok() {
        return Ok(None);
    }

    let executable = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name("vision_detector.exe");
    if !executable.is_file() {
        return Err(format!(
            "No se encontro el sidecar en {}",
            executable.display()
        ));
    }

    let executable_wide = wide_null(&executable);
    let working_directory = executable
        .parent()
        .map(wide_null)
        .ok_or_else(|| "No se pudo resolver el directorio del sidecar".to_string())?;
    let mut startup = STARTUPINFOW::default();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut process = PROCESS_INFORMATION::default();
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            let error = std::io::Error::last_os_error().to_string();
            CloseHandle(job);
            return Err(error);
        }
        if CreateProcessW(
            executable_wide.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            std::ptr::null(),
            working_directory.as_ptr(),
            &startup,
            &mut process,
        ) == 0
        {
            let error = std::io::Error::last_os_error().to_string();
            CloseHandle(job);
            return Err(error);
        }
        if AssignProcessToJobObject(job, process.hProcess) == 0 {
            let error = std::io::Error::last_os_error().to_string();
            CloseHandle(process.hThread);
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            return Err(error);
        }
        if ResumeThread(process.hThread) == u32::MAX {
            let error = std::io::Error::last_os_error().to_string();
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            TerminateJobObject(job, 1);
            CloseHandle(job);
            return Err(error);
        }
        CloseHandle(process.hThread);
        Ok(Some(ManagedVisionProcess {
            job,
            process: process.hProcess,
            _launch_lock: launch_lock,
        }))
    }
}

enum VisionAction {
    Start(u64),
    Stop(u64),
}

fn vision_worker(app: AppHandle) {
    loop {
        let closing = app
            .state::<Mutex<VisionState>>()
            .lock()
            .map(|state| state.closing)
            .unwrap_or(true);
        if closing {
            break;
        }

        match vision_health() {
            Ok(health) => {
                let action = {
                    let state_handle = app.state::<Mutex<VisionState>>();
                    let Ok(mut state) = state_handle.lock() else {
                        break;
                    };
                    state.service_detected = true;
                    state.started_at = None;
                    state.retry_requested = false;

                    match health {
                        VisionHealthState::Ready if state.camera_requested => {
                            state.phase = VisionPhase::StartingCamera;
                            state.detail = None;
                            if state.start_sent_generation != Some(state.camera_generation) {
                                state.start_sent_generation = Some(state.camera_generation);
                                state.action_in_progress = true;
                                Some(VisionAction::Start(state.camera_generation))
                            } else {
                                None
                            }
                        }
                        VisionHealthState::Ready if state.stop_requested => {
                            if state.stop_sent_generation != Some(state.camera_generation) {
                                state.phase = VisionPhase::StoppingCamera;
                                state.detail = None;
                                state.stop_sent_generation = Some(state.camera_generation);
                                state.action_in_progress = true;
                                Some(VisionAction::Stop(state.camera_generation))
                            } else {
                                state.stop_requested = false;
                                state.phase = VisionPhase::Ready;
                                state.detail = None;
                                None
                            }
                        }
                        VisionHealthState::Ready => {
                            state.phase = VisionPhase::Ready;
                            state.detail = None;
                            None
                        }
                        VisionHealthState::Running if state.camera_requested => {
                            state.phase = VisionPhase::Running;
                            state.detail = None;
                            None
                        }
                        VisionHealthState::Running => {
                            state.phase = VisionPhase::StoppingCamera;
                            state.detail = None;
                            if state.stop_sent_generation != Some(state.camera_generation) {
                                state.stop_sent_generation = Some(state.camera_generation);
                                state.action_in_progress = true;
                                Some(VisionAction::Stop(state.camera_generation))
                            } else {
                                None
                            }
                        }
                        VisionHealthState::Starting if state.camera_requested => {
                            state.phase = VisionPhase::StartingCamera;
                            state.detail = None;
                            None
                        }
                        VisionHealthState::Starting => {
                            state.phase = VisionPhase::StoppingCamera;
                            state.detail = None;
                            if state.stop_sent_generation != Some(state.camera_generation) {
                                state.stop_sent_generation = Some(state.camera_generation);
                                state.action_in_progress = true;
                                Some(VisionAction::Stop(state.camera_generation))
                            } else {
                                None
                            }
                        }
                        VisionHealthState::Stopping => {
                            state.phase = VisionPhase::StoppingCamera;
                            state.detail = None;
                            None
                        }
                        VisionHealthState::Error(message) => {
                            state.phase = VisionPhase::Error;
                            state.detail = Some(message);
                            None
                        }
                    }
                };

                if let Some(action) = action {
                    let (path, generation, requested) = match action {
                        VisionAction::Start(generation) => ("/start", generation, true),
                        VisionAction::Stop(generation) => ("/stop", generation, false),
                    };
                    let result = vision_post(path);
                    if let Ok(mut state) = app.state::<Mutex<VisionState>>().lock() {
                        state.action_in_progress = false;
                        if state.camera_generation == generation
                            && state.camera_requested == requested
                            && result.is_err()
                        {
                            state.phase = VisionPhase::Error;
                            state.detail = result.err();
                        }
                    }
                }
            }
            Err(error) => {
                let should_spawn = {
                    let state_handle = app.state::<Mutex<VisionState>>();
                    let Ok(mut state) = state_handle.lock() else {
                        break;
                    };

                    let process_finished = state
                        .process
                        .as_ref()
                        .is_some_and(|process| !process.is_running());
                    let startup_timed_out = state.phase == VisionPhase::Preparing
                        && state
                            .started_at
                            .is_some_and(|started| started.elapsed() >= VISION_STARTUP_TIMEOUT);

                    if process_finished || startup_timed_out {
                        if let Some(process) = state.process.take() {
                            process.terminate();
                        }
                        state.owned = false;
                        state.service_detected = false;
                        state.retry_requested = false;
                        state.phase = VisionPhase::Error;
                        state.detail = Some(if process_finished {
                            "El proceso de vision finalizo inesperadamente.".into()
                        } else {
                            "El servicio de vision no estuvo listo despues de 30 segundos.".into()
                        });
                        false
                    } else if state.process.is_none()
                        && state.retry_requested
                        && !state.service_detected
                    {
                        state.retry_requested = false;
                        state.started_at.get_or_insert_with(Instant::now);
                        true
                    } else {
                        if state.phase != VisionPhase::Preparing || state.service_detected {
                            state.phase = VisionPhase::Error;
                            state.detail = Some(format!("El servicio de vision no responde: {error}"));
                        }
                        false
                    }
                };

                if should_spawn {
                    match spawn_managed_vision() {
                        Ok(Some(process)) => {
                            let mut process = Some(process);
                            if let Ok(mut state) = app.state::<Mutex<VisionState>>().lock() {
                                if !state.closing {
                                    state.process = process.take();
                                    state.owned = true;
                                    state.service_detected = false;
                                    state.phase = VisionPhase::Preparing;
                                    state.detail = None;
                                    state.started_at = Some(Instant::now());
                                }
                            }
                            if let Some(process) = process {
                                process.terminate();
                            }
                        }
                        Ok(None) => {
                            if let Ok(mut state) = app.state::<Mutex<VisionState>>().lock() {
                                state.phase = VisionPhase::Preparing;
                                state.detail =
                                    Some("Esperando otra instancia del servicio de vision.".into());
                            }
                        }
                        Err(error) => {
                            if let Ok(mut state) = app.state::<Mutex<VisionState>>().lock() {
                                state.phase = VisionPhase::Error;
                                state.detail = Some(error);
                            }
                        }
                    }
                }
            }
        }

        thread::sleep(VISION_POLL_INTERVAL);
    }

    if let Ok(mut state) = app.state::<Mutex<VisionState>>().lock() {
        state.worker_running = false;
    }
}

#[tauri::command]
fn prepare_vision(app: AppHandle) -> Result<VisionStatus, String> {
    let (start_worker, stale_process) = {
        let state_handle = app.state::<Mutex<VisionState>>();
        let mut state = state_handle
            .lock()
            .map_err(|_| "VISION_STATE_LOCK_FAILED")?;
        if state.closing {
            return Ok(VisionStatus::from(&*state));
        }

        let retrying = state.phase == VisionPhase::Error;
        let stale_process = if retrying && state.owned {
            state.owned = false;
            state.service_detected = false;
            state.process.take()
        } else {
            None
        };
        if retrying {
            state.phase = VisionPhase::Preparing;
            state.detail = None;
            state.started_at = Some(Instant::now());
            state.retry_requested = !state.service_detected;
            state.start_sent_generation = None;
            state.stop_sent_generation = None;
        } else if !state.worker_running {
            state.phase = VisionPhase::Preparing;
            state.detail = None;
            state.started_at = Some(Instant::now());
            state.retry_requested = true;
        }

        let start_worker = !state.worker_running;
        if start_worker {
            state.worker_running = true;
        }
        (start_worker, stale_process)
    };

    if let Some(process) = stale_process {
        process.terminate();
    }
    if start_worker {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || vision_worker(worker_app));
    }
    vision_status_snapshot(&app)
}

#[tauri::command]
fn start_vision(app: AppHandle, generation: u64) -> Result<VisionStatus, String> {
    let start_worker = {
        let state_handle = app.state::<Mutex<VisionState>>();
        let mut state = state_handle
            .lock()
            .map_err(|_| "VISION_STATE_LOCK_FAILED")?;
        if generation > state.camera_generation {
            state.camera_requested = true;
            state.stop_requested = false;
            state.camera_generation = generation;
            state.start_sent_generation = None;
            state.stop_sent_generation = None;
            if state.phase == VisionPhase::Ready {
                state.phase = VisionPhase::StartingCamera;
            }
        }
        let start_worker = !state.worker_running && !state.closing;
        if start_worker {
            state.worker_running = true;
            state.retry_requested = true;
            state.phase = VisionPhase::Preparing;
            state.detail = None;
            state.started_at = Some(Instant::now());
        }
        start_worker
    };
    if start_worker {
        let worker_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || vision_worker(worker_app));
    }
    vision_status_snapshot(&app)
}

#[tauri::command]
fn vision_status(app: AppHandle) -> Result<VisionStatus, String> {
    vision_status_snapshot(&app)
}

#[tauri::command]
fn stop_vision(app: AppHandle, generation: u64) -> Result<VisionStatus, String> {
    {
        let state_handle = app.state::<Mutex<VisionState>>();
        let mut state = state_handle
            .lock()
            .map_err(|_| "VISION_STATE_LOCK_FAILED")?;
        if generation > state.camera_generation {
            state.camera_requested = false;
            state.stop_requested = true;
            state.camera_generation = generation;
            state.start_sent_generation = None;
            state.stop_sent_generation = None;
            if matches!(
                state.phase,
                VisionPhase::StartingCamera | VisionPhase::Running
            ) {
                state.phase = VisionPhase::StoppingCamera;
                state.detail = None;
            }
        }
    }
    vision_status_snapshot(&app)
}

fn shutdown_vision_service(app: &AppHandle) {
    {
        let state_handle = app.state::<Mutex<VisionState>>();
        let Ok(mut state) = state_handle.lock() else {
            return;
        };
        state.closing = true;
        state.camera_requested = false;
        state.stop_requested = false;
        state.camera_generation = state.camera_generation.wrapping_add(1);
    }

    let action_deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < action_deadline {
        let action_in_progress = app
            .state::<Mutex<VisionState>>()
            .lock()
            .map(|state| state.action_in_progress)
            .unwrap_or(false);
        if !action_in_progress {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let (process, external_service) = {
        let state_handle = app.state::<Mutex<VisionState>>();
        let Ok(mut state) = state_handle.lock() else {
            return;
        };
        if state.owned {
            state.owned = false;
            state.service_detected = false;
            (state.process.take(), false)
        } else {
            (None, state.service_detected)
        }
    };

    if let Some(process) = process {
        let _ = vision_post("/shutdown");
        if !process.wait(VISION_SHUTDOWN_TIMEOUT) {
            process.terminate();
            let _ = process.wait(Duration::from_secs(1));
        }
    } else if external_service {
        let _ = vision_post("/stop");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(vision_health(), Ok(VisionHealthState::Ready)) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

#[tauri::command]
async fn shutdown_vision(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shutdown_vision_service(&app))
        .await
        .map_err(|error| error.to_string())
}

fn terminate_owned_vision(app: &AppHandle) {
    let state_handle = app.state::<Mutex<VisionState>>();
    let process = state_handle
        .lock()
        .ok()
        .and_then(|mut state| {
            state.closing = true;
            if state.owned {
                state.owned = false;
                state.process.take()
            } else {
                None
            }
        });
    if let Some(process) = process {
        process.terminate();
        let _ = process.wait(Duration::from_secs(1));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(SerialState {
            port: None,
            connected: false,
            session: 0,
        }))
        .manage(Mutex::new(VisionState::new()))
        .invoke_handler(tauri::generate_handler![
            list_ports,
            save_position,
            list_positions,
            delete_position,
            save_trajectory,
            list_trajectories,
            delete_trajectory,
            connect,
            disconnect,
            send_command,
            prepare_vision,
            start_vision,
            vision_status,
            stop_vision,
            shutdown_vision
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app, event| {
        match event {
            RunEvent::ExitRequested { code, api, .. } => {
                let should_shutdown = app
                    .state::<Mutex<VisionState>>()
                    .lock()
                    .map(|state| (state.owned || state.service_detected) && !state.closing)
                    .unwrap_or(false);
                if should_shutdown {
                    api.prevent_exit();
                    let exit_code = code.unwrap_or(0);
                    let shutdown_app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        shutdown_vision_service(&shutdown_app);
                        shutdown_app.exit(exit_code);
                    });
                }
            }
            RunEvent::Exit => terminate_owned_vision(app),
            _ => {}
        }
    });
}

#[cfg(test)]
mod vision_tests {
    use super::*;

    #[test]
    fn parses_service_and_camera_states() {
        assert!(matches!(
            parse_vision_health(r#"{"status":"ready","camera_active":false}"#),
            Ok(VisionHealthState::Ready)
        ));
        assert!(matches!(
            parse_vision_health(r#"{"status":"running","camera_active":true}"#),
            Ok(VisionHealthState::Running)
        ));
        assert!(matches!(
            parse_vision_health(
                r#"{"status":"error","camera_active":false,"message":"camara ocupada"}"#
            ),
            Ok(VisionHealthState::Error(message)) if message == "camara ocupada"
        ));
    }
}

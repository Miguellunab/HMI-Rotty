use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

struct SerialState {
    port: Option<Box<dyn SerialPort>>,
    connected: bool,
    session: u64,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(SerialState {
            port: None,
            connected: false,
            session: 0,
        }))
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
            send_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

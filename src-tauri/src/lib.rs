use serde::Serialize;
use serialport::SerialPort;
use std::{
    io::{BufRead, BufReader, Write},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};

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

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
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

#[tauri::command]
fn list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
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
            connect,
            disconnect,
            send_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

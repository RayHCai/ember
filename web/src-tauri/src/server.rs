//! Starts the Ember server (FastAPI + the Python agent) with the app and stops
//! it when the app quits. In development it runs from the repo's `.venv`; in a
//! bundled app it runs the `ember-server` sidecar shipped inside the bundle.
//!
//! The server's pid is written to a file. If the app is killed before it can
//! stop the server (for example when `tauri dev` restarts it), the next launch
//! finds the pid, takes the server back, and stops it on quit. A server started
//! some other way (`make dev`) is reused but never stopped by the app.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const SERVER_PORT: u16 = 8000;

pub enum Owned {
    /// Started by this run of the app.
    Child(Child),
    /// Started by an earlier run that did not get to stop it.
    Adopted(u32),
}

/// The server process this app owns, if any.
pub struct ServerProcess(pub Mutex<Option<Owned>>);

/// True if an Ember server already answers on the port.
pub fn ember_server_running() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], SERVER_PORT).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.contains("\"ok\":true")
}

#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[cfg(debug_assertions)]
fn pid_file(_app: &AppHandle) -> Option<PathBuf> {
    Some(repo_root().join(".ember-server.pid"))
}

#[cfg(not(debug_assertions))]
fn pid_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("server.pid"))
}

#[cfg(debug_assertions)]
fn server_command(_app: &AppHandle) -> Result<Command, String> {
    let repo = repo_root();
    let python = repo.join(".venv/bin/python");
    if !python.exists() {
        return Err(format!(
            "{} not found. Run `make setup` in the repo first.",
            python.display()
        ));
    }
    let mut cmd = Command::new(python);
    cmd.args(["-m", "uvicorn", "app.main:app", "--app-dir"])
        .arg(repo.join("server"))
        .args(["--host", "127.0.0.1", "--port", &SERVER_PORT.to_string()])
        .current_dir(&repo);
    Ok(cmd)
}

#[cfg(not(debug_assertions))]
fn server_command(app: &AppHandle) -> Result<Command, String> {
    use std::fs::{self, File};
    use std::process::Stdio;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sidecar = exe
        .parent()
        .ok_or("cannot find the app's executable folder")?
        .join("ember-server");
    if !sidecar.exists() {
        return Err(format!("{} is missing from the app bundle", sidecar.display()));
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log = File::create(log_dir.join("server.log")).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(sidecar);
    cmd.args(["--port", &SERVER_PORT.to_string()])
        .env("EMBER_DATA_DIR", &data_dir)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    Ok(cmd)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn signal(pid: u32, sig: libc::c_int) {
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

fn read_pid(app: &AppHandle) -> Option<u32> {
    std::fs::read_to_string(pid_file(app)?).ok()?.trim().parse().ok()
}

fn write_pid(app: &AppHandle, pid: u32) {
    if let Some(path) = pid_file(app) {
        let _ = std::fs::write(path, pid.to_string());
    }
}

fn clear_pid(app: &AppHandle) {
    if let Some(path) = pid_file(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Start the server unless one is already running.
pub fn start(app: &AppHandle) {
    let state = app.state::<ServerProcess>();
    if ember_server_running() {
        match read_pid(app).filter(|pid| process_alive(*pid)) {
            Some(pid) => {
                log::info!("Took back the Ember server an earlier run started (pid {pid})");
                *state.0.lock().unwrap() = Some(Owned::Adopted(pid));
            }
            None => log::info!("Using the Ember server already running on port {SERVER_PORT}"),
        }
        return;
    }
    match server_command(app).and_then(|mut cmd| cmd.spawn().map_err(|e| e.to_string())) {
        Ok(child) => {
            log::info!("Started the Ember server (pid {})", child.id());
            write_pid(app, child.id());
            *state.0.lock().unwrap() = Some(Owned::Child(child));
        }
        // The console still opens and shows "Reconnecting", so the operator sees the problem.
        Err(err) => log::error!("Could not start the Ember server: {err}"),
    }
}

/// Stop the server this app owns. SIGTERM first so it shuts down cleanly.
pub fn stop(app: &AppHandle) {
    let Some(owned) = app.state::<ServerProcess>().0.lock().unwrap().take() else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    match owned {
        Owned::Child(mut child) => {
            #[cfg(unix)]
            signal(child.id(), libc::SIGTERM);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        Owned::Adopted(pid) => {
            #[cfg(unix)]
            {
                signal(pid, libc::SIGTERM);
                while Instant::now() < deadline && process_alive(pid) {
                    std::thread::sleep(Duration::from_millis(50));
                }
                if process_alive(pid) {
                    signal(pid, libc::SIGKILL);
                }
            }
        }
    }
    clear_pid(app);
    log::info!("Stopped the Ember server");
}

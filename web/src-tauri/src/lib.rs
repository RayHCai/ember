mod server;

use std::sync::Mutex;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(server::ServerProcess(Mutex::new(None)))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            server::start(app.handle());
            #[cfg(unix)]
            quit_on_signals(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Ember app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            server::stop(handle);
        }
    });
}

/// Treat Ctrl-C, `kill` and terminal hangups like quitting from the menu, so
/// the app still stops the server it started.
#[cfg(unix)]
fn quit_on_signals(handle: tauri::AppHandle) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    match Signals::new([SIGINT, SIGTERM, SIGHUP]) {
        Ok(mut signals) => {
            std::thread::spawn(move || {
                if signals.forever().next().is_some() {
                    handle.exit(0);
                }
            });
        }
        Err(err) => log::warn!("Could not listen for quit signals: {err}"),
    }
}

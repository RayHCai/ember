// Ember desktop app: the operator console in a native window. All data is
// built-in dummy data in the console itself; there is no backend to start.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Webview errors and notes land in the app log (terminal in development).
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running the Ember app");
}

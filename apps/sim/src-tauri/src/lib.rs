//! Tauri shell for Ember Drone Sim. Everything the app does lives in the TypeScript frontend; the shell
//! hosts the window and hands it the launch settings `scripts/start.mjs` puts in the environment.

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Runs before the page's own scripts, so `src/launch.ts` finds the settings on first read.
fn launch_script() -> String {
    let launch = serde_json::json!({
        "drone": env("EMBER_DRONE"),
        "droneInfoUrl": env("EMBER_DRONE_INFO_URL"),
        "demoDataUrl": env("EMBER_DEMO_DATA_URL"),
    });
    format!("window.emberSimLaunch = {launch};")
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let title = match env("EMBER_DRONE") {
                Some(drone) => format!("Ember Drone Sim · {drone}"),
                None => "Ember Drone Sim".to_string(),
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(launch_script())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ember Drone Sim");
}

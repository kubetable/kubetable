mod adapters;
mod cluster_store;
mod commands;
mod deploy;
mod discovery;
mod error;
mod portforward;

use cluster_store::ClusterStore;
use commands::AppState;
use portforward::PortForwardManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("kubetable=debug")),
        )
        .init();

    // macOS .app bundles inherit a minimal GUI PATH (/usr/bin:/bin:/usr/sbin:/sbin),
    // so kubectl + cloud-auth helpers (gke-gcloud-auth-plugin, aws, doctl) installed
    // via Homebrew or krew are not found, producing "No such file or directory
    // (os error 2)" when port-forward tries to spawn them. Widen PATH here so any
    // Command::new("kubectl") downstream resolves.
    augment_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState {
                pfm: PortForwardManager::new(),
                store: ClusterStore::new(data_dir),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.pfm.shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_contexts,
            commands::current_context,
            commands::list_cluster_sources,
            commands::add_cluster_file,
            commands::add_cluster_yaml,
            commands::remove_cluster_source,
            commands::list_namespaces,
            commands::discover_services,
            commands::resolve_credentials,
            commands::connect,
            commands::disconnect,
            commands::active_tunnels,
            commands::run_query,
            commands::explain_query,
            commands::get_schema,
            commands::check_operator_installed,
            commands::install_operator,
            commands::list_db_operators,
            commands::preview_deploy,
            commands::deploy_database,
            commands::delete_database,
            commands::get_deploy_status,
            commands::diagnose_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn augment_path() {
    let mut entries: Vec<std::path::PathBuf> = Vec::new();

    let mut candidates: Vec<std::path::PathBuf> = vec![
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/local/sbin".into(),
    ];
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(home);
        candidates.push(home.join(".krew/bin"));
        candidates.push(home.join("bin"));
        candidates.push(home.join(".local/bin"));
    }

    let existing = std::env::var_os("PATH").unwrap_or_default();
    for p in std::env::split_paths(&existing) {
        entries.push(p);
    }

    for c in candidates {
        if c.is_dir() && !entries.iter().any(|e| e == &c) {
            entries.push(c);
        }
    }

    if let Ok(joined) = std::env::join_paths(&entries) {
        std::env::set_var("PATH", joined);
    }
}

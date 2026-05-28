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

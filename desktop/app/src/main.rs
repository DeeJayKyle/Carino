// Carino for Windows. The window runs the same app and engine as the phone (its data stays in this
// window's storage on this PC). Rust adds what a web page can't do itself:
//  - listen on the local network so a paired phone can sync (the phone can't accept connections);
//  - the PC's local addresses, for the pairing QR code;
//  - (later phases) chosen folders and approved apps, each behind explicit permission.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use carino_sync_listener::{lan_addresses as private_addresses, Listener, DEFAULT_PORT};
use tauri::{Emitter, Manager};

mod apps;
mod files;
mod vault;
mod localai;

/// Sync requests waiting for the window's answer, by id.
#[derive(Default)]
struct Pending(Mutex<HashMap<u64, SyncSender<String>>>);

struct Port(u16);

#[tauri::command]
fn lan_addresses(port: tauri::State<Port>) -> Vec<String> {
    let ips: Vec<IpAddr> = if_addrs::get_if_addrs().map(|v| v.into_iter().map(|i| i.ip()).collect()).unwrap_or_default();
    private_addresses(port.0, &ips)
}

/// The window's answer to a sync request it was given.
#[tauri::command]
fn sync_reply(id: u64, body: String, pending: tauri::State<Arc<Pending>>) {
    if let Some(tx) = pending.0.lock().unwrap().remove(&id) {
        let _ = tx.send(body);
    }
}

fn main() {
    let pending = Arc::new(Pending::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(apps::Apps::default())
        .manage(pending.clone())
        .manage(files::Grants::default())
        .setup(move |app| {
            // Folders chosen in earlier sessions.
            *app.state::<files::Grants>().0.lock().unwrap() = files::load(app.handle());
            *app.state::<apps::Apps>().0.lock().unwrap() = apps::load(app.handle());
            let handle = app.handle().clone();
            let next = Arc::new(AtomicU64::new(1));
            let p = pending.clone();
            // Each request goes to the window (which opens it with the pair's key) and its answer comes back.
            let handler: carino_sync_listener::Handler = Arc::new(move |body: String| {
                let id = next.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = sync_channel(1);
                p.0.lock().unwrap().insert(id, tx);
                handle
                    .emit("carino-sync-request", serde_json::json!({ "id": id, "body": body }))
                    .map_err(|e| e.to_string())?;
                let out = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "Carino on the PC didn't answer in time".to_string());
                p.0.lock().unwrap().remove(&id);
                out
            });
            let port = std::env::var("CARINO_SYNC_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT);
            match Listener::start(&format!("0.0.0.0:{port}"), handler) {
                Ok(l) => {
                    app.manage(Port(port));
                    // Kept for the life of the app.
                    Box::leak(Box::new(l));
                }
                Err(e) => {
                    eprintln!("[carino] sync listener: {e}");
                    app.manage(Port(port));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lan_addresses, sync_reply,
            files::pick_folder, files::forget_folder, files::fs_list, files::fs_read, files::fs_rename, files::fs_delete_recover, files::fs_restore, files::fs_write,
            apps::list_apps, apps::pick_app, apps::forget_app, apps::open_app, apps::open_file,
            vault::vault_seal, vault::vault_open,
            localai::probe_local_ai,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Carino");
}

//! Apps on this PC the user approved, one at a time, by choosing the program in Windows' own file
//! dialog. Carino can open only those (optionally with a file from a chosen folder), and open files
//! from chosen folders with their usual app. Programs and scripts inside folders are never run.
//! No commands, no typing into other apps, no control of anything else.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::files::{inside, Grants};

#[derive(Clone, Serialize, Deserialize)]
pub struct App { id: String, name: String, path: PathBuf }

#[derive(Default)]
pub struct Apps(pub Mutex<Vec<App>>);

/// Files that would run code if "opened": refused.
const RUNNABLE: &[&str] = &["exe", "bat", "cmd", "com", "msi", "msp", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "scr", "pif", "lnk", "reg", "jar", "cpl", "msc", "appref-ms", "url", "inf", "dll", "sys"];

pub fn runnable(path: &std::path::Path) -> bool {
    path.extension().map(|e| RUNNABLE.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false)
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("apps.json"))
}

pub fn load(app: &AppHandle) -> Vec<App> {
    file(app).ok().and_then(|f| fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, list: &[App]) -> Result<(), String> {
    fs::write(file(app)?, serde_json::to_string(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_apps(app: AppHandle) -> Vec<App> {
    app.state::<Apps>().0.lock().unwrap().clone()
}

/// Approves a program the user picks in Windows' file dialog.
#[tauri::command]
pub async fn pick_app(app: AppHandle) -> Result<Option<App>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Choose an app Carino may open").add_filter("Programs", &["exe"]).blocking_pick_file();
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let name = p.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let a = App { id: uuid::Uuid::new_v4().to_string(), name, path: p };
    let state = app.state::<Apps>();
    let mut list = state.0.lock().unwrap();
    list.retain(|x| x.path != a.path);
    list.push(a.clone());
    save(&app, &list)?;
    Ok(Some(a))
}

#[tauri::command]
pub fn forget_app(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<Apps>();
    let mut list = state.0.lock().unwrap();
    list.retain(|x| x.id != id);
    save(&app, &list)
}

/// Opens an approved app, optionally with a file from a chosen folder. The program is started
/// directly (no shell), so nothing in the file name can become a command.
#[tauri::command]
pub fn open_app(app: AppHandle, id: String, root: Option<String>, rel: Option<String>) -> Result<(), String> {
    let a = app.state::<Apps>().0.lock().unwrap().iter().find(|x| x.id == id).cloned().ok_or("That app isn't one you approved for Carino.")?;
    let mut cmd = Command::new(&a.path);
    if let (Some(root), Some(rel)) = (root, rel) {
        let grants = app.state::<Grants>().0.lock().unwrap().clone();
        cmd.arg(inside(&grants, &root, &rel)?);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Couldn't open {}: {e}", a.name))
}

/// Opens a file from a chosen folder with its usual app (never a program or script).
#[tauri::command]
pub fn open_file(app: AppHandle, root: String, rel: String) -> Result<(), String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let p = inside(&grants, &root, &rel)?;
    if runnable(&p) { return Err("Carino doesn't open programs or scripts.".into()); }
    app.opener().open_path(p.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn programs_and_scripts_are_never_opened() {
        for f in ["setup.exe", "run.BAT", "x.ps1", "a.lnk", "b.js", "c.hta", "d.reg"] { assert!(runnable(std::path::Path::new(f)), "{f}"); }
        for f in ["Budget.xlsx", "letter.docx", "scan.pdf", "photo.jpg", "notes.txt"] { assert!(!runnable(std::path::Path::new(f)), "{f}"); }
    }
}

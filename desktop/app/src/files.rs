//! Folders the user chose in Windows' own folder dialog, and nothing else.
//!
//! Rust keeps the list of chosen folders itself (in Carino's app-data folder), so even if the page
//! asked for some other path, it would be refused. Every path is resolved and must stay inside its
//! folder (no "..", no links leading out). Changes only happen after the user approved them in the
//! app; a delete first copies the file to Carino's recovery folder and checks the copy.

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Grants(pub Mutex<Vec<PathBuf>>);

#[derive(Serialize)]
pub struct Entry { rel: String, name: String, dir: bool, size: u64, mtime: String }

#[derive(Serialize)]
pub struct Picked { root: String, label: String }

fn store(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn load(app: &AppHandle) -> Vec<PathBuf> {
    store(app).ok().and_then(|d| fs::read_to_string(d.join("folders.json")).ok()).and_then(|s| serde_json::from_str::<Vec<PathBuf>>(&s).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, list: &[PathBuf]) -> Result<(), String> {
    fs::write(store(app)?.join("folders.json"), serde_json::to_string(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A path inside a chosen folder, or an error. `rel` uses "/" between parts.
pub fn inside(grants: &[PathBuf], root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "That folder isn't available.".to_string())?;
    if !grants.iter().any(|g| fs::canonicalize(g).map(|g| g == root).unwrap_or(false)) {
        return Err("That folder wasn't chosen for Carino.".into());
    }
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) && !rel.as_os_str().is_empty() {
        return Err("That path is outside the folder.".into());
    }
    let target = root.join(rel);
    // For a path that doesn't exist yet, check its nearest existing parent.
    let mut base = target.clone();
    let mut rest = Vec::new();
    while !base.exists() {
        rest.push(base.file_name().ok_or("Bad path")?.to_owned());
        base = base.parent().ok_or("Bad path")?.to_path_buf();
    }
    let mut real = fs::canonicalize(&base).map_err(|e| e.to_string())?;
    for p in rest.into_iter().rev() {
        real.push(p);
    }
    if !real.starts_with(&root) {
        return Err("That path is outside the folder.".into());
    }
    Ok(real)
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<Picked>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Choose a folder Carino may read").blocking_pick_folder();
    let Some(p) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let p = fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let grants = app.state::<Grants>();
    let mut list = grants.0.lock().unwrap();
    if !list.contains(&p) {
        list.push(p.clone());
        save(&app, &list)?;
    }
    let label = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string_lossy().to_string());
    Ok(Some(Picked { root: p.to_string_lossy().to_string(), label }))
}

#[tauri::command]
pub fn forget_folder(app: AppHandle, root: String) -> Result<(), String> {
    let grants = app.state::<Grants>();
    let mut list = grants.0.lock().unwrap();
    let r = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    list.retain(|g| fs::canonicalize(g).map(|g| g != r).unwrap_or(false) && *g != PathBuf::from(&root));
    save(&app, &list)
}

#[tauri::command]
pub fn fs_list(app: AppHandle, root: String, rel: String) -> Result<Vec<Entry>, String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let dir = inside(&grants, &root, &rel)?;
    let base = fs::canonicalize(&root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let Ok(real) = fs::canonicalize(e.path()) else { continue };
        if !real.starts_with(&base) { continue; } // a link leading out of the folder
        let Ok(md) = fs::metadata(&real) else { continue };
        let rel = real.strip_prefix(&base).unwrap().components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/");
        let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis().to_string()).unwrap_or_default();
        out.push(Entry { rel, name, dir: md.is_dir(), size: md.len(), mtime });
    }
    Ok(out)
}

#[tauri::command]
pub fn fs_read(app: AppHandle, root: String, rel: String, max_bytes: u64) -> Result<String, String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let p = inside(&grants, &root, &rel)?;
    if fs::metadata(&p).map_err(|e| e.to_string())?.len() > max_bytes { return Err("That file is too large to read.".into()); }
    Ok(base64::engine::general_purpose::STANDARD.encode(fs::read(&p).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub fn fs_rename(app: AppHandle, root: String, rel: String, to_rel: String) -> Result<(), String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let from = inside(&grants, &root, &rel)?;
    let to = inside(&grants, &root, &to_rel)?;
    if to.exists() { return Err(format!("There is already a file at {to_rel}.")); }
    if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::rename(from, to).map_err(|e| e.to_string())
}

/// Writes a new file (approved in the app first); never replaces an existing one.
#[tauri::command]
pub fn fs_write(app: AppHandle, root: String, rel: String, b64: String) -> Result<(), String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let to = inside(&grants, &root, &rel)?;
    if to.exists() { return Err(format!("There is already a file at {rel}.")); }
    if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    fs::OpenOptions::new().write(true).create_new(true).open(&to).and_then(|mut f| std::io::Write::write_all(&mut f, &bytes)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_delete_recover(app: AppHandle, root: String, rel: String, sha256_hex: String) -> Result<String, String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let p = inside(&grants, &root, &rel)?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if sha256(&bytes) != sha256_hex { return Err(format!("{rel} changed since it was checked. Look again before deleting it.")); }
    let dir = store(&app)?.join("recovery");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let copy = dir.join(format!("{}.bin", uuid::Uuid::new_v4()));
    fs::write(&copy, &bytes).map_err(|e| e.to_string())?;
    if sha256(&fs::read(&copy).map_err(|e| e.to_string())?) != sha256_hex {
        let _ = fs::remove_file(&copy);
        return Err("The safety copy didn't check out, so nothing was deleted.".into());
    }
    fs::remove_file(&p).map_err(|e| e.to_string())?;
    Ok(copy.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_restore(app: AppHandle, root: String, rel: String, recovery: String, sha256_hex: String) -> Result<(), String> {
    let grants = app.state::<Grants>().0.lock().unwrap().clone();
    let rec_dir = fs::canonicalize(store(&app)?.join("recovery")).map_err(|e| e.to_string())?;
    let rec = fs::canonicalize(&recovery).map_err(|_| "The saved copy is missing.".to_string())?;
    if !rec.starts_with(&rec_dir) { return Err("That isn't one of Carino's saved copies.".into()); }
    let bytes = fs::read(&rec).map_err(|e| e.to_string())?;
    if sha256(&bytes) != sha256_hex { return Err("The saved copy is damaged; it can't be restored.".into()); }
    let to = inside(&grants, &root, &rel)?;
    if to.exists() { return Err(format!("There is already a file at {rel}.")); }
    if let Some(parent) = to.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&to, &bytes).map_err(|e| e.to_string())?;
    if sha256(&fs::read(&to).map_err(|e| e.to_string())?) != sha256_hex { return Err("The restored file didn't check out.".into()); }
    let _ = fs::remove_file(&rec);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_chosen_folders_and_only_inside_them() {
        let base = std::env::temp_dir().join(format!("carino-files-{}", uuid::Uuid::new_v4()));
        let chosen = base.join("Documents");
        let other = base.join("Private");
        fs::create_dir_all(&chosen).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(chosen.join("a.txt"), "a").unwrap();
        fs::write(other.join("secret.txt"), "s").unwrap();
        let grants = vec![fs::canonicalize(&chosen).unwrap()];
        let root = chosen.to_string_lossy().to_string();
        assert!(inside(&grants, &root, "a.txt").is_ok());
        assert!(inside(&grants, &root, "New folder/b.txt").is_ok()); // somewhere new, still inside
        assert!(inside(&grants, &root, "../Private/secret.txt").is_err());
        assert!(inside(&grants, &other.to_string_lossy(), "secret.txt").is_err()); // not chosen
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(other.join("secret.txt"), chosen.join("link.txt")).unwrap();
            assert!(inside(&grants, &root, "link.txt").is_err());
        }
        let _ = fs::remove_dir_all(&base);
    }
}

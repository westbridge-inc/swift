// Swift Mission Control — Tauri shell.
//
// The app is local; the data is not. The ONLY native powers exposed to the
// webview are these Keychain commands (desktop standing order 28: tokens live
// in the macOS Keychain — never plists, JSON stores, localStorage, or logs).
// Everything else is plain HTTPS to the admin API from the webview.

const SERVICE: &str = "gy.swift.mission-control";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keychain_get,
            keychain_set,
            keychain_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

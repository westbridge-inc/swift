// Swift Mission Control — Tauri shell.
//
// The app is local; the data is not. The ONLY native powers exposed to the
// webview are these Keychain commands (desktop standing order 28: tokens live
// in the macOS Keychain — never plists, JSON stores, localStorage, or logs).
// Everything else is plain HTTPS to the admin API from the webview.

use tauri::{
    menu::{Menu, MenuItemBuilder, SubmenuBuilder, WINDOW_SUBMENU_ID},
    Emitter,
};

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

#[tauri::command]
fn set_operator_menu_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let menu = app
        .menu()
        .ok_or_else(|| "Mission Control menu is unavailable".to_owned())?;

    for id in ["mc:queue-menu", "mc:record-menu"] {
        let item = menu
            .get(id)
            .ok_or_else(|| format!("Mission Control menu item {id} is unavailable"))?;
        let submenu = item
            .as_submenu()
            .ok_or_else(|| format!("Mission Control menu item {id} is not a submenu"))?;
        submenu.set_enabled(enabled).map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Keep Tauri's native macOS app/File/Edit/View/Window/Help menus and
        // insert Mission Control's two operator menus before Window. Reusing
        // the default menu preserves standard macOS Window/Help semantics.
        .menu(|app| {
            let search = MenuItemBuilder::with_id("mc:search", "Search Everything…")
                .accelerator("CmdOrCtrl+K")
                .build(app)?;

            let queue = SubmenuBuilder::with_id(app, "mc:queue-menu", "Queue")
                .enabled(false)
                .text("mc:review", "Document Review")
                .text("mc:live-ops", "Live Operations")
                .text("mc:stuck", "Stuck Orders")
                .build()?;

            let record = SubmenuBuilder::with_id(app, "mc:record-menu", "Record")
                .enabled(false)
                .item(&search)
                .separator()
                .text("mc:people", "People")
                .text("mc:vendors", "Businesses")
                .build()?;

            let menu = Menu::default(app)?;
            let items = menu.items()?;
            let before_window = items
                .iter()
                .position(|item| item.id() == WINDOW_SUBMENU_ID)
                .unwrap_or(items.len());
            menu.insert_items(&[&queue, &record], before_window)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            if id.starts_with("mc:") {
                if let Err(error) = app.emit("mc-native-menu", id.to_owned()) {
                    eprintln!("native menu event failed: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            keychain_get,
            keychain_set,
            keychain_delete,
            set_operator_menu_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

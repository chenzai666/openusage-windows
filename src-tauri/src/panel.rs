//! Panel / floating window control.
//!
//! On macOS the original edition used `tauri-nspanel` for a non-activating
//! menu-bar panel. On Windows (and other non-macOS desktops) we use the
//! standard Tauri webview window, positioned near the tray icon.

use tauri::{AppHandle, Manager, Position, Size, WebviewWindow};

fn monitor_contains_physical_point(
    origin_x: f64,
    origin_y: f64,
    width: f64,
    height: f64,
    point_x: f64,
    point_y: f64,
) -> bool {
    point_x >= origin_x
        && point_x < origin_x + width
        && point_y >= origin_y
        && point_y < origin_y + height
}

/// Macro to get the main window, initializing panel state if needed.
/// Returns `Option<WebviewWindow>`.
macro_rules! get_or_init_panel {
    ($app_handle:expr) => {
        match $app_handle.get_webview_window("main") {
            Some(window) => {
                if let Err(err) = crate::panel::init($app_handle) {
                    log::error!("Failed to init panel: {}", err);
                }
                Some(window)
            }
            None => {
                log::error!("Main webview window missing");
                None
            }
        }
    };
}

// Export macro for use in other modules
pub(crate) use get_or_init_panel;

fn show_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn hide_window(window: &WebviewWindow) {
    let _ = window.hide();
}

fn is_window_visible(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false)
}

/// Retrieve the tray icon rect and position the panel beneath it.
/// No-ops gracefully if the tray icon or its rect is unavailable.
fn position_panel_from_tray(app_handle: &AppHandle) {
    let Some(tray) = app_handle.tray_by_id("tray") else {
        log::debug!("position_panel_from_tray: tray icon not found");
        return;
    };
    match tray.rect() {
        Ok(Some(rect)) => {
            position_panel_at_tray_icon(app_handle, rect.position, rect.size);
        }
        Ok(None) => {
            log::debug!("position_panel_from_tray: tray rect not available yet");
        }
        Err(e) => {
            log::warn!("position_panel_from_tray: failed to get tray rect: {}", e);
        }
    }
}

/// Show the panel (initializing if needed), positioned under the tray icon.
pub fn show_panel(app_handle: &AppHandle) {
    if let Some(window) = get_or_init_panel!(app_handle) {
        show_window(&window);
        position_panel_from_tray(app_handle);
    }
}

/// Hide the panel if present.
pub fn hide_panel(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        hide_window(&window);
    }
}

/// Toggle panel visibility. If visible, hide it. If hidden, show it.
/// Used by global shortcut handler.
pub fn toggle_panel(app_handle: &AppHandle) {
    let Some(window) = get_or_init_panel!(app_handle) else {
        return;
    };

    if is_window_visible(&window) {
        log::debug!("toggle_panel: hiding panel");
        hide_window(&window);
    } else {
        log::debug!("toggle_panel: showing panel");
        show_window(&window);
        position_panel_from_tray(app_handle);
    }
}

/// One-time window setup (focus-loss hide, decorations already in conf).
pub fn init(app_handle: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(());
    };

    // Only attach the focus listener once.
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    if INIT.set(()).is_err() {
        return Ok(());
    }

    let handle = app_handle.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            // Small delay so clicks inside the window still register first.
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                if let Some(win) = handle.get_webview_window("main") {
                    // Only hide if still unfocused (user didn't re-focus).
                    if !win.is_focused().unwrap_or(true) {
                        let _ = win.hide();
                    }
                }
            });
        }
    });

    // Keep the window above normal apps while open, without forcing always-on-top permanently.
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);

    Ok(())
}

pub fn position_panel_at_tray_icon(
    app_handle: &tauri::AppHandle,
    icon_position: Position,
    icon_size: Size,
) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };

    let (icon_phys_x, icon_phys_y) = match &icon_position {
        Position::Physical(pos) => (pos.x as f64, pos.y as f64),
        Position::Logical(pos) => (pos.x, pos.y),
    };
    let (icon_phys_w, icon_phys_h) = match &icon_size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width, s.height),
    };

    let monitors = match window.available_monitors() {
        Ok(m) => m,
        Err(e) => {
            log::warn!("failed to get monitors: {}", e);
            return;
        }
    };

    let icon_center_x = icon_phys_x + (icon_phys_w / 2.0);
    let icon_center_y = icon_phys_y + (icon_phys_h / 2.0);

    let found_monitor = monitors.iter().find(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        monitor_contains_physical_point(
            origin.x as f64,
            origin.y as f64,
            size.width as f64,
            size.height as f64,
            icon_center_x,
            icon_center_y,
        )
    });

    let monitor = match found_monitor {
        Some(m) => m.clone(),
        None => {
            log::warn!(
                "No monitor found for tray rect center at ({:.0}, {:.0}), using primary",
                icon_center_x,
                icon_center_y
            );
            match window.primary_monitor() {
                Ok(Some(m)) => m,
                _ => return,
            }
        }
    };

    let target_scale = monitor.scale_factor();
    let mon_phys_x = monitor.position().x as f64;
    let mon_phys_y = monitor.position().y as f64;
    let mon_phys_w = monitor.size().width as f64;
    let mon_phys_h = monitor.size().height as f64;
    let mon_logical_x = mon_phys_x / target_scale;
    let mon_logical_y = mon_phys_y / target_scale;
    let mon_logical_w = mon_phys_w / target_scale;
    let mon_logical_h = mon_phys_h / target_scale;

    let icon_logical_x = mon_logical_x + (icon_phys_x - mon_phys_x) / target_scale;
    let icon_logical_y = mon_logical_y + (icon_phys_y - mon_phys_y) / target_scale;
    let icon_logical_w = icon_phys_w / target_scale;
    let icon_logical_h = icon_phys_h / target_scale;

    // Read panel width from the window, converted to logical points.
    let panel_width = match (window.outer_size(), window.scale_factor()) {
        (Ok(s), Ok(win_scale)) if win_scale > 0.0 => s.width as f64 / win_scale,
        _ => {
            let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");
            conf["app"]["windows"][0]["width"]
                .as_f64()
                .expect("width must be set in tauri.conf.json")
        }
    };

    let panel_height = match (window.outer_size(), window.scale_factor()) {
        (Ok(s), Ok(win_scale)) if win_scale > 0.0 => s.height as f64 / win_scale,
        _ => {
            let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");
            conf["app"]["windows"][0]["height"]
                .as_f64()
                .unwrap_or(500.0)
        }
    };

    let icon_center_x = icon_logical_x + (icon_logical_w / 2.0);
    let mut panel_x = icon_center_x - (panel_width / 2.0);

    // Clamp horizontally inside the monitor work area.
    panel_x = panel_x
        .max(mon_logical_x + 8.0)
        .min(mon_logical_x + mon_logical_w - panel_width - 8.0);

    // Windows tray is typically at the bottom of the screen. Prefer placing
    // the panel above the tray icon; fall back to below if there isn't room.
    let gap: f64 = 8.0;
    let above_y = icon_logical_y - panel_height - gap;
    let below_y = icon_logical_y + icon_logical_h + gap;
    let panel_y = if above_y >= mon_logical_y + 8.0 {
        above_y
    } else {
        below_y
            .min(mon_logical_y + mon_logical_h - panel_height - 8.0)
            .max(mon_logical_y + 8.0)
    };

    let _ = window.set_position(Position::Logical(tauri::LogicalPosition {
        x: panel_x,
        y: panel_y,
    }));
}

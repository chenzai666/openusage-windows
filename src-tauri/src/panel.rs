//! Panel / floating window control.
//!
//! On macOS the original edition used `tauri-nspanel` for a non-activating
//! menu-bar panel. On Windows (and other non-macOS desktops) we use the
//! standard Tauri webview window, positioned near the tray icon.

use tauri::{AppHandle, Emitter, Manager, Position, Size, WebviewWindow};

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

/// Notify the webview that the panel was just snapped to the tray.
/// Frontend drops its bottom-edge lock so the next content resize re-captures.
pub fn notify_panel_shown(app_handle: &AppHandle) {
    if let Err(e) = app_handle.emit("tray:panel-shown", ()) {
        log::debug!("emit tray:panel-shown failed: {}", e);
    }
}

fn emit_panel_shown(app_handle: &AppHandle) {
    notify_panel_shown(app_handle);
}

/// Show the panel (initializing if needed), positioned under the tray icon.
pub fn show_panel(app_handle: &AppHandle) {
    if let Some(window) = get_or_init_panel!(app_handle) {
        show_window(&window);
        position_panel_from_tray(app_handle);
        emit_panel_shown(app_handle);
    }
}

/// Re-anchor the (already visible) panel to the tray / taskbar.
/// Used sparingly (e.g. explicit recovery) — not on every content resize.
pub fn reanchor_panel(app_handle: &AppHandle) {
    position_panel_from_tray(app_handle);
    emit_panel_shown(app_handle);
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
        emit_panel_shown(app_handle);
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
            // Delay so clicks / drag-start inside the window still register.
            // Slightly longer than before so data-tauri-drag-region can begin.
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(280));
                if let Some(win) = handle.get_webview_window("main") {
                    // Only hide if still unfocused (user didn't re-focus / drag).
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

    let mon_phys_x = monitor.position().x as f64;
    let mon_phys_y = monitor.position().y as f64;
    let mon_phys_w = monitor.size().width as f64;
    let mon_phys_h = monitor.size().height as f64;

    // Prefer physical outer size so DPI scaling matches frontend setSize(PhysicalSize).
    let (panel_phys_w, panel_phys_h) = match window.outer_size() {
        Ok(s) => (s.width as f64, s.height as f64),
        Err(_) => {
            let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");
            let scale = monitor.scale_factor().max(0.1);
            let w = conf["app"]["windows"][0]["width"].as_f64().unwrap_or(400.0) * scale;
            let h = conf["app"]["windows"][0]["height"].as_f64().unwrap_or(360.0) * scale;
            (w, h)
        }
    };

    let icon_center_x = icon_phys_x + (icon_phys_w / 2.0);
    let mut panel_x = icon_center_x - (panel_phys_w / 2.0);

    // Clamp horizontally inside the monitor bounds (physical px).
    let margin = 8.0;
    panel_x = panel_x
        .max(mon_phys_x + margin)
        .min(mon_phys_x + mon_phys_w - panel_phys_w - margin);

    // Windows tray is typically at the bottom. Place the panel just above the
    // tray icon so the bottom edge stays glued to the taskbar after resizes.
    let gap: f64 = 4.0;
    let above_y = icon_phys_y - panel_phys_h - gap;
    let below_y = icon_phys_y + icon_phys_h + gap;
    let panel_y = if above_y >= mon_phys_y + margin {
        above_y
    } else {
        // Top/side taskbar fallback: sit below the icon, still on-screen.
        below_y
            .min(mon_phys_y + mon_phys_h - panel_phys_h - margin)
            .max(mon_phys_y + margin)
    };

    let _ = window.set_position(Position::Physical(tauri::PhysicalPosition {
        x: panel_x.round() as i32,
        y: panel_y.round() as i32,
    }));
}

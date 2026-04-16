use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct TimerAtoms {
    work_start_ms: AtomicI64,
    break_end_ms: AtomicI64,
}

type TimerState = Arc<TimerAtoms>;

fn refresh_tray_title(app: &tauri::AppHandle, state: &TimerAtoms) {
    let work = state.work_start_ms.load(Ordering::Relaxed);
    let brk = state.break_end_ms.load(Ordering::Relaxed);
    let now = now_ms();
    let title: String = if work > 0 {
        format_tray_elapsed(work)
    } else if brk > 0 && brk > now {
        format_tray_countdown(brk - now)
    } else {
        String::new()
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(title.as_str()));
    }
}

#[tauri::command]
fn set_timer_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TimerState>,
    start_ms: i64,
) {
    state.work_start_ms.store(start_ms, Ordering::Relaxed);
    refresh_tray_title(&app, &state);
}

#[tauri::command]
fn set_break_end(
    app: tauri::AppHandle,
    state: tauri::State<'_, TimerState>,
    end_ms: i64,
) {
    state.break_end_ms.store(end_ms, Ordering::Relaxed);
    refresh_tray_title(&app, &state);
}


fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn format_tray_elapsed(start_ms: i64) -> String {
    let elapsed = (now_ms() - start_ms).max(0);
    let total_sec = elapsed / 1000;
    let h = total_sec / 3600;
    let m = (total_sec % 3600) / 60;
    let s = total_sec % 60;
    if h > 0 {
        format!(" {}:{:02}:{:02}", h, m, s)
    } else {
        format!(" {}:{:02}", m, s)
    }
}

fn format_tray_countdown(remaining_ms: i64) -> String {
    let total_sec = remaining_ms.max(0) / 1000;
    let m = total_sec / 60;
    let s = total_sec % 60;
    format!(" ☕ {}:{:02}", m, s)
}

#[tauri::command]
fn toggle_window(app: tauri::AppHandle) -> Result<(), String> {
    toggle_window_impl(&app);
    Ok(())
}

fn toggle_window_impl(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            if let Some(tray) = app.tray_by_id("main") {
                if let Ok(rect) = tray.rect() {
                    if let Some(rect) = rect {
                        let window_size = window.outer_size().unwrap_or_default();
                        let (tray_x, tray_y) = match rect.position {
                            tauri::Position::Physical(p) => (p.x, p.y),
                            tauri::Position::Logical(p) => (p.x as i32, p.y as i32),
                        };
                        let (tray_w, tray_h) = match rect.size {
                            tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
                            tauri::Size::Logical(s) => (s.width as i32, s.height as i32),
                        };
                        let x = tray_x + (tray_w / 2) - (window_size.width as i32 / 2);
                        let y = tray_y + tray_h + 4;
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                    }
                }
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut = Shortcut::new(
        Some(Modifiers::SUPER | Modifiers::ALT),
        Code::KeyF,
    );

    let timer_state: TimerState = Arc::new(TimerAtoms::default());

    tauri::Builder::default()
        .manage(timer_state.clone())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler({
                    let toggle_shortcut = toggle_shortcut;
                    move |app, shortcut, event| {
                        if *shortcut == toggle_shortcut
                            && event.state() == ShortcutState::Pressed
                        {
                            toggle_window_impl(app);
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_timer_start,
            set_break_end,
            toggle_window
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    Some(12.0),
                );
            }

            let quit_item = MenuItem::with_id(app, "quit", "Quit Forge Dev", true, None::<&str>)?;
            let show_item = MenuItem::with_id(
                app,
                "show",
                "Open Forge  ⌘⌥F",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray.png");
            let tray_icon = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)
                .expect("failed to load tray icon");

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let visible = window.is_visible().unwrap_or(false);
                            if visible {
                                let _ = window.hide();
                            } else {
                                let window_size = window.outer_size().unwrap_or_default();
                                let (tray_x, tray_y) = match rect.position {
                                    tauri::Position::Physical(p) => (p.x, p.y),
                                    tauri::Position::Logical(p) => (p.x as i32, p.y as i32),
                                };
                                let (tray_w, tray_h) = match rect.size {
                                    tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
                                    tauri::Size::Logical(s) => (s.width as i32, s.height as i32),
                                };
                                let x = tray_x + (tray_w / 2) - (window_size.width as i32 / 2);
                                let y = tray_y + tray_h + 4;
                                let _ = window.set_position(PhysicalPosition::new(x, y));
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            let _ = app.global_shortcut().register(toggle_shortcut);

            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = window_clone.hide();
                    }
                });
            }

            let app_for_idle = app.handle().clone();
            let timer_state_for_idle = timer_state.clone();
            std::thread::spawn(move || {
                // Two-stage idle handling:
                //  - 10 min idle  -> emit `idle-warning` (soft notification, no pause yet)
                //  - 13 min idle  -> emit `idle-detected` (actual pause with trimmed time)
                // Any keyboard/mouse activity resets both flags so the cycle can re-fire later.
                let warn_threshold = Duration::from_secs(10 * 60);
                let pause_threshold = Duration::from_secs(13 * 60);
                let mut warning_sent = false;
                let mut pause_sent = false;
                loop {
                    std::thread::sleep(Duration::from_secs(30));
                    let work = timer_state_for_idle
                        .work_start_ms
                        .load(Ordering::Relaxed);
                    if work == 0 {
                        warning_sent = false;
                        pause_sent = false;
                        continue;
                    }
                    let Ok(idle) = user_idle::UserIdle::get_time() else {
                        continue;
                    };
                    let idle_dur = idle.duration();
                    if idle_dur < warn_threshold {
                        warning_sent = false;
                        pause_sent = false;
                        continue;
                    }
                    if idle_dur >= pause_threshold && !pause_sent {
                        let _ = app_for_idle
                            .emit("idle-detected", idle_dur.as_millis() as i64);
                        pause_sent = true;
                        continue;
                    }
                    if idle_dur >= warn_threshold && !warning_sent {
                        let _ = app_for_idle
                            .emit("idle-warning", idle_dur.as_millis() as i64);
                        warning_sent = true;
                    }
                }
            });

            let app_for_tick = app.handle().clone();
            let timer_state_for_tick = timer_state.clone();
            std::thread::spawn(move || {
                let mut last_title: String = String::new();
                loop {
                    std::thread::sleep(Duration::from_millis(250));
                    let work = timer_state_for_tick.work_start_ms.load(Ordering::Relaxed);
                    let brk = timer_state_for_tick.break_end_ms.load(Ordering::Relaxed);
                    let now = now_ms();
                    let next: String = if work > 0 {
                        format_tray_elapsed(work)
                    } else if brk > 0 && brk > now {
                        format_tray_countdown(brk - now)
                    } else {
                        String::new()
                    };
                    if next != last_title {
                        if let Some(tray) = app_for_tick.tray_by_id("main") {
                            let _ = tray.set_title(Some(next.as_str()));
                        }
                        last_title = next;
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

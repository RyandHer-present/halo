mod alerts;
mod audio;
mod display;
mod files;
mod fps;
mod icons;
mod launcher;
mod media;
mod net;
mod notifs;
mod procs;
mod stats;
mod system;
mod tools;
mod updates;
mod viz;

pub static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/// Cover the monitor the mouse is on, then show + focus and tell the UI to animate in.
fn show_overlay(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let monitor = w
        .cursor_position()
        .ok()
        .and_then(|p| w.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let _ = w.set_position(PhysicalPosition::new(m.position().x, m.position().y));
        let _ = w.set_size(PhysicalSize::new(m.size().width, m.size().height));
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();
    let _ = app.emit("halo://show", ());
}

/// Ask the UI to animate out; it calls `hide_window` when done.
fn request_hide(app: &AppHandle) {
    let _ = app.emit("halo://hide", ());
}

fn toggle(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            request_hide(app);
        } else {
            show_overlay(app);
        }
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    show_overlay(&app);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    fps::stop(&app);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_hidden = std::env::args().any(|a| a == "--hidden");
    let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);
    let fps_key = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyF);
    let talk_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_overlay(app)))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    let pressed = ev.state() == ShortcutState::Pressed;
                    if sc == &hotkey && pressed {
                        toggle(app);
                    } else if sc == &fps_key && pressed {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = fps::fps_toggle(app).await {
                                alerts::show_toast("FPS overlay", &e, "warn");
                            }
                        });
                    } else if sc == &talk_key {
                        // push-to-talk (Ctrl+Shift+Space): open Halo on the assistant and record while held
                        if pressed {
                            show_overlay(app);
                            let _ = app.emit("halo://page", "ai");
                        }
                        let _ = app.emit("halo://ptt", pressed);
                    }
                })
                .build(),
        )
        .manage(stats::StatsWorker::spawn())
        .manage(media::MediaState(Mutex::new(Default::default())))
        .manage(viz::VizState(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            for k in [hotkey, fps_key, talk_key] {
                if let Err(e) = app.global_shortcut().register(k) {
                    eprintln!("hotkey registration failed: {e}");
                }
            }

            // Tray
            let open = MenuItem::with_id(app, "open", "Open Halo", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Halo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &quit])?;
            TrayIconBuilder::with_id("halo")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Halo  ·  Win+Shift+D")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_overlay(app),
                    "settings" => {
                        show_overlay(app);
                        let _ = app.emit("halo://page", "settings");
                    }
                    "quit" => {
                        fps::stop(app);
                        app.exit(0)
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle(tray.app_handle());
                    }
                })
                .build(app)?;

            if !start_hidden {
                show_overlay(&handle);
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                request_hide(w.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            hide_window,
            show_window,
            quit_app,
            stats::get_stats,
            media::now_playing,
            media::media_cmd,
            audio::get_audio,
            audio::set_volume,
            audio::set_mute,
            audio::set_audio_device,
            audio::get_app_volumes,
            audio::set_app_volume,
            audio::get_exe_path,
            icons::get_icon,
            launcher::get_games,
            launcher::launch_game,
            launcher::get_start_apps,
            launcher::launch_path,
            launcher::read_image,
            system::power_action,
            system::get_power_mode,
            system::set_power_mode,
            system::get_radios,
            system::set_radio,
            system::get_wifi,
            system::connect_wifi,
            system::disconnect_wifi,
            system::get_windows_accent,
            system::get_wallpaper,
            system::is_admin,
            system::set_autostart,
            system::get_autostart,
            viz::viz_start,
            viz::viz_stop,
            procs::get_processes,
            procs::kill_process,
            procs::kill_by_name,
            procs::set_priority,
            procs::open_location,
            procs::get_services,
            procs::service_action,
            procs::get_startup,
            procs::set_startup,
            procs::get_programs,
            procs::uninstall_program,
            alerts::set_alerts,
            alerts::toast_pending,
            alerts::toast_done,
            alerts::test_toast,
            files::scan_folder,
            files::cancel_scan,
            files::trash_paths,
            files::restore_paths,
            files::cleanup_scan,
            files::cleanup_run,
            files::big_files,
            files::find_duplicates,
            files::quick_folders,
            files::recent_files,
            files::sort_downloads_now,
            files::clean_installers_now,
            files::organizer_log,
            files::set_organizer,
            files::list_dir,
            files::read_text,
            files::write_text,
            files::move_path,
            files::path_exists,
            display::get_displays,
            display::set_display_mode,
            display::set_hdr,
            display::set_scale,
            display::get_input,
            display::set_input,
            display::get_default_apps,
            display::change_default_app,
            net::speed_test,
            net::scan_lan,
            net::public_ip,
            net::tts_request,
            updates::winget_updates,
            updates::winget_upgrade,
            updates::winget_search,
            updates::winget_install,
            updates::windows_updates,
            updates::install_windows_updates,
            updates::check_halo_update,
            updates::install_halo_update,
            notifs::get_notifications,
            notifs::open_aumid,
            tools::screenshot,
            tools::run_powershell,
            fps::fps_toggle,
            fps::fps_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Halo");
}

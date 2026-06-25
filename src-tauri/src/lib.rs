use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use rodio::{source::SineWave, source::Source, DeviceSinkBuilder};
use serde::{Deserialize, Serialize};

/// Work interval in seconds (20 minutes for production).
const WORK_INTERVAL_SECS: u64 = 20 * 60;

/// Application timer state shared across commands.
struct TimerState {
    /// Whether the countdown is currently running.
    running: bool,
    /// Whether the timer is paused.
    paused: bool,
    /// Total remaining seconds in the current work interval.
    remaining_secs: u64,
    /// Instant when the timer last ticked (used for accurate delta calculation).
    last_tick: Instant,
}

impl Default for TimerState {
    fn default() -> Self {
        Self {
            running: true,
            paused: false,
            remaining_secs: WORK_INTERVAL_SECS,
            last_tick: Instant::now(),
        }
    }
}

impl TimerState {
    fn toggle_pause(&mut self) -> bool {
        self.paused = !self.paused;
        if !self.paused {
            self.last_tick = Instant::now();
        }
        self.paused
    }

    fn reset(&mut self) {
        self.remaining_secs = WORK_INTERVAL_SECS;
        self.paused = false;
        self.running = true;
        self.last_tick = Instant::now();
    }
}

/// Shared flag: when false, the overlay window blocks all close attempts.
/// Only set to true by the backend when the break is over.
struct OverlayCloseAllowed(Arc<AtomicBool>);

/// Shared state for tracking remaining seconds in the active break.
struct BreakState(Arc<AtomicU64>);

#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    strict_mode: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { strict_mode: true }
    }
}

struct SettingsState(Mutex<AppSettings>);

fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).join("settings.json")
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let path = settings_path(app);
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(settings) = serde_json::from_str(&content) {
            return settings;
        }
    }
    AppSettings::default()
}

fn save_settings(app: &AppHandle, settings: &AppSettings) {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, content);
    }
}

// ─── Tauri Commands ─────────────────────────────────────────

/// Return the current remaining seconds on the work timer.
#[tauri::command]
fn get_remaining(state: tauri::State<'_, Mutex<TimerState>>) -> u64 {
    let s = state.lock().unwrap();
    s.remaining_secs
}

/// Return whether the timer is currently paused.
#[tauri::command]
fn is_paused(state: tauri::State<'_, Mutex<TimerState>>) -> bool {
    let s = state.lock().unwrap();
    s.paused
}

/// Toggle pause / resume. Returns the new paused state.
#[tauri::command]
fn toggle_pause(state: tauri::State<'_, Mutex<TimerState>>) -> bool {
    state.lock().unwrap().toggle_pause()
}

/// Reset the timer back to the work interval and unpause.
#[tauri::command]
fn reset_timer(state: tauri::State<'_, Mutex<TimerState>>) {
    state.lock().unwrap().reset();
}

/// Send the system notification for the break.
#[tauri::command]
fn send_break_notification(app: AppHandle) {
    let _ = app
        .notification()
        .builder()
        .title("Time for a Break!")
        .body("Look at something 20 feet (6 meters) away for 20 seconds.")
        .show();
}

/// Open (or re-show) the fullscreen overlay break window.
#[tauri::command]
fn open_overlay(app: AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.show();
        let _ = win.set_focus();
        force_fullscreen(&app, &win);
        return;
    }
    build_overlay_window(&app);
}

/// Close the overlay window (only called by the backend timer or frontend manual close).
#[tauri::command]
fn close_overlay(app: AppHandle) {
    // Allow close
    let flag = app.state::<OverlayCloseAllowed>();
    flag.0.store(true, Ordering::SeqCst);

    // Immediately stop the background break countdown
    let b = app.state::<BreakState>();
    b.0.store(0, Ordering::SeqCst);

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.close();
    }

    // Bring main window to the front
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.unminimize();
        let _ = main_win.set_focus();
    }
}

/// Add 20 seconds to the currently running break.
#[tauri::command]
fn add_break_time(state: tauri::State<'_, BreakState>) {
    state.0.fetch_add(20, Ordering::SeqCst);
}

#[tauri::command]
fn get_strict_mode(state: tauri::State<'_, SettingsState>) -> bool {
    state.0.lock().unwrap().strict_mode
}

#[tauri::command]
fn set_strict_mode(app: AppHandle, state: tauri::State<'_, SettingsState>, strict_mode: bool) {
    let mut s = state.0.lock().unwrap();
    s.strict_mode = strict_mode;
    save_settings(&app, &s);
    let _ = app.emit("settings-changed", strict_mode);
}

/// Force a window to cover the entire primary monitor.
fn force_fullscreen(app: &AppHandle, win: &tauri::WebviewWindow) {
    // Get monitor dimensions and size the window to fill the screen
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        let _ = win.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = win.set_size(PhysicalSize::new(size.width, size.height));
    }
    let _ = win.set_fullscreen(true);
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
}

/// Build the overlay window with close-prevention.
fn build_overlay_window(app: &AppHandle) {
    let strict_mode = app.state::<SettingsState>().0.lock().unwrap().strict_mode;
    let close_allowed = app.state::<OverlayCloseAllowed>().0.clone();
    
    // Reset flag: if strict mode, overlay is NOT allowed to close until break ends.
    // If flexible mode, it's allowed to close immediately.
    close_allowed.store(!strict_mode, Ordering::SeqCst);

    // Get monitor dimensions for initial window size
    let (width, height) = if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        (size.width, size.height)
    } else {
        (1920, 1080) // fallback
    };

    let builder = WebviewWindowBuilder::new(
        app,
        "overlay",
        WebviewUrl::App("overlay.html".into()),
    )
    .title("Break Time!")
    .inner_size(width as f64, height as f64)
    .position(0.0, 0.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .minimizable(false)
    .closable(false)
    .focused(true);

    if let Ok(win) = builder.build() {
        // Force fullscreen after build (more reliable on Linux)
        let _ = win.set_fullscreen(true);

        // Intercept ALL close requests (Alt+F4, WM close, etc.) and block them
        // unless the backend has explicitly allowed it.
        // Also intercept focus loss (e.g. from Super key) and force focus back!
        let flag = close_allowed;
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if !flag.load(Ordering::SeqCst) {
                        api.prevent_close();
                    }
                }
                WindowEvent::Focused(focused) if !*focused && !flag.load(Ordering::SeqCst) => {
                    // User tried to switch windows or pressed Super key.
                    // Force focus back to the overlay!
                    let _ = win_clone.set_focus();
                    let _ = win_clone.set_always_on_top(true);
                }
                _ => {}
            }
        });
    }
}

// ─── Background Timer Thread ────────────────────────────────

fn start_background_timer(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));

            let should_break = {
                let state = handle.state::<Mutex<TimerState>>();
                let mut s = state.lock().unwrap();

                if !s.running || s.paused {
                    continue;
                }

                let now = Instant::now();
                let elapsed = now.duration_since(s.last_tick).as_secs();
                s.last_tick = now;

                if elapsed >= s.remaining_secs {
                    s.remaining_secs = 0;
                    true
                } else {
                    s.remaining_secs -= elapsed;
                    false
                }
            };

            // Emit tick to frontend
            let _ = handle.emit("timer-tick", ());

            if should_break {
                // Fire notification
                let _ = handle
                    .notification()
                    .builder()
                    .title("Time for a Break!")
                    .body("Look at something 20 feet (6 meters) away for 20 seconds.")
                    .show();

                // Tell the frontend the break has started
                let _ = handle.emit("break-start", ());

                // Open the overlay
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let strict_mode = h.state::<SettingsState>().0.lock().unwrap().strict_mode;
                    let flag = h.state::<OverlayCloseAllowed>();
                    flag.0.store(!strict_mode, Ordering::SeqCst);

                    if let Some(win) = h.get_webview_window("overlay") {
                        let _ = win.show();
                        force_fullscreen(&h, &win);
                    } else {
                        build_overlay_window(&h);
                    }
                });

                // Reset the break timer to 20 seconds initially
                {
                    let b = handle.state::<BreakState>();
                    b.0.store(20, Ordering::SeqCst);
                }

                // Wait for the window to actually open and frontend to load
                std::thread::sleep(Duration::from_millis(1500));

                // Open the audio device once per break to prevent ALSA locking issues on Linux
                let mut audio_sink = DeviceSinkBuilder::open_default_sink().ok();
                if let Some(ref mut sink) = audio_sink {
                    sink.log_on_drop(false);
                }

                // Wait for the break to finish, emitting ticks to the frontend.
                // We use BreakState so that the frontend can dynamically add time.
                loop {
                    let b = handle.state::<BreakState>();
                    
                    let mut current = b.0.load(Ordering::SeqCst);
                    let rem = loop {
                        if current == 0 {
                            break 0;
                        }
                        match b.0.compare_exchange_weak(current, current - 1, Ordering::SeqCst, Ordering::Relaxed) {
                            Ok(_) => break current - 1,
                            Err(x) => current = x,
                        }
                    };

                    if current == 0 {
                        break;
                    }
                    
                    let _ = handle.emit("break-tick", rem);

                    // Play tick sound when 5s or less remain
                    if rem <= 5 && rem > 0 {
                        if let Some(ref sink) = audio_sink {
                            let source = SineWave::new(1200.0)
                                .take_duration(Duration::from_millis(30))
                                .amplify(0.15);
                            sink.mixer().add(source);
                        }
                    }
                    
                    std::thread::sleep(Duration::from_secs(1));
                }

                // Explicitly drop the audio sink to free the device for other apps
                drop(audio_sink);

                let _ = handle.emit("break-tick", 0);
                std::thread::sleep(Duration::from_millis(500)); // Brief pause at 0

                // Now allow close, then close the overlay, and show the main window
                let h2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let flag = h2.state::<OverlayCloseAllowed>();
                    flag.0.store(true, Ordering::SeqCst);

                    if let Some(win) = h2.get_webview_window("overlay") {
                        let _ = win.close();
                    }

                    // Bring main window to the front
                    if let Some(main_win) = h2.get_webview_window("main") {
                        let _ = main_win.show();
                        let _ = main_win.unminimize();
                        let _ = main_win.set_focus();
                    }
                });

                let _ = handle.emit("break-end", ());

                // Reset the work timer (the MutexGuard is dropped immediately after this line)
                handle.state::<Mutex<TimerState>>().lock().unwrap().reset();
            }
        }
    });
}

// ─── Tray Icon ──────────────────────────────────────────────

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::CheckMenuItemBuilder;
    
    let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
    
    let is_autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Start on Boot")
        .checked(is_autostart)
        .build(app)?;
        
    let is_strict = load_settings(app).strict_mode;
    let strict_mode_item = CheckMenuItemBuilder::with_id("strict_mode", "Strict Mode")
        .checked(is_strict)
        .build(app)?;
        
    let pause_item = MenuItemBuilder::with_id("pause", "Pause").build(app)?;
    let reset_item = MenuItemBuilder::with_id("reset", "Reset Timer").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show_item, &autostart_item, &strict_mode_item, &pause_item, &reset_item, &quit_item])
        .build()?;

    let icon = Image::from_path("icons/32x32.png")
        .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/32x32.png")).unwrap());

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("20-20-20 Eye Rest")
        .on_menu_event(move |app_handle, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let _ = win.unminimize();
                }
            }
            "autostart" => {
                let autolaunch = app_handle.autolaunch();
                if let Ok(enabled) = autolaunch.is_enabled() {
                    if enabled {
                        let _ = autolaunch.disable();
                    } else {
                        let _ = autolaunch.enable();
                    }
                }
            }
            "strict_mode" => {
                let state = app_handle.state::<SettingsState>();
                let mut settings = state.0.lock().unwrap();
                settings.strict_mode = !settings.strict_mode;
                save_settings(app_handle, &settings);
                let _ = app_handle.emit("settings-changed", settings.strict_mode);
            }
            "pause" => {
                app_handle.state::<Mutex<TimerState>>().lock().unwrap().toggle_pause();
                let _ = app_handle.emit("timer-tick", ());
            }
            "reset" => {
                app_handle.state::<Mutex<TimerState>>().lock().unwrap().reset();
                let _ = app_handle.emit("timer-tick", ());
            }
            "quit" => {
                app_handle.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// ─── Entry Point ────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(TimerState::default()))
        .manage(OverlayCloseAllowed(Arc::new(AtomicBool::new(true))))
        .manage(BreakState(Arc::new(AtomicU64::new(0))))
        .invoke_handler(tauri::generate_handler![
            get_remaining,
            is_paused,
            toggle_pause,
            reset_timer,
            send_break_notification,
            open_overlay,
            close_overlay,
            add_break_time,
            get_strict_mode,
            set_strict_mode,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = load_settings(&handle);
            app.manage(SettingsState(Mutex::new(settings)));
            
            setup_tray(&handle)?;
            start_background_timer(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

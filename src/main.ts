import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Constants ──────────────────────────────────────────────

let TOTAL_WORK_SECS = 1200;

interface AppSettings {
  strict_mode: boolean;
  work_duration_secs: number;
  break_duration_secs: number;
}
const CIRCUMFERENCE = 2 * Math.PI * 88; // matches SVG circle r=88

// ─── DOM Elements ───────────────────────────────────────────

const $minutes = document.getElementById("timer-minutes") as HTMLSpanElement;
const $seconds = document.getElementById("timer-seconds") as HTMLSpanElement;
const $statusBadge = document.getElementById("status-badge") as HTMLDivElement;
const $statusText = document.getElementById("status-text") as HTMLSpanElement;
const $btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
const $mainTitle = document.getElementById("main-title") as HTMLHeadingElement;
const $btnOpenSettings = document.getElementById("btn-open-settings") as HTMLButtonElement;
const $btnCloseSettings = document.getElementById("btn-close-settings") as HTMLButtonElement;
const $settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
const $btnSaveSettings = document.getElementById("btn-save-settings") as HTMLButtonElement;
const $btnQuitApp = document.getElementById("btn-quit-app") as HTMLButtonElement;
const $progress = document.getElementById("timer-progress") as unknown as SVGCircleElement;
const $strictBadge = document.getElementById("strict-badge") as HTMLDivElement;
const $strictIndicator = document.getElementById("strict-indicator") as HTMLSpanElement;
const $btnPauseText = document.getElementById("btn-pause-text") as HTMLSpanElement;
const $iconPause = document.getElementById("icon-pause") as unknown as SVGElement;
const $iconPlay = document.getElementById("icon-play") as unknown as SVGElement;
const $btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const $infoCountdown = document.getElementById("info-countdown") as HTMLElement;
const $inputWork = document.getElementById("input-work-duration") as HTMLInputElement;
const $inputBreak = document.getElementById("input-break-duration") as HTMLInputElement;

// ─── Rendering ──────────────────────────────────────────────

function formatTime(totalSecs: number): { mm: string; ss: string; display: string } {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return { mm, ss, display: `${mm}:${ss}` };
}

function updateUI(remaining: number) {
  const { mm, ss, display } = formatTime(remaining);

  $minutes.textContent = mm;
  $seconds.textContent = ss;
  $infoCountdown.textContent = display;

  // Update SVG ring progress
  const fraction = remaining / TOTAL_WORK_SECS;
  const offset = CIRCUMFERENCE * (1 - fraction);
  $progress.style.strokeDasharray = `${CIRCUMFERENCE}`;
  $progress.style.strokeDashoffset = `${offset}`;

  // Change ring color as time runs low
  if (remaining <= 60) {
    $progress.style.stroke = "#ff6b6b";
    $progress.style.filter = "drop-shadow(0 0 8px rgba(255,107,107,0.3))";
  } else if (remaining <= 5 * 60) {
    $progress.style.stroke = "#fdcb6e";
    $progress.style.filter = "drop-shadow(0 0 8px rgba(253,203,110,0.3))";
  } else {
    $progress.style.stroke = "";
    $progress.style.filter = "";
  }
}

function setStatusUI(paused: boolean) {
  if (paused) {
    $statusBadge.className = "status-badge status-paused";
    $statusText.textContent = "Paused";
    $iconPause.classList.add("hidden");
    $iconPlay.classList.remove("hidden");
    $btnPauseText.textContent = "Resume";
  } else {
    $statusBadge.className = "status-badge status-running";
    $statusText.textContent = "Running";
    $iconPause.classList.remove("hidden");
    $iconPlay.classList.add("hidden");
    $btnPauseText.textContent = "Pause";
  }
}

// ─── Event Handlers ─────────────────────────────────────────

$btnPause.addEventListener("click", async () => {
  const newPaused = await invoke<boolean>("toggle_pause");
  setStatusUI(newPaused);
});

$btnReset.addEventListener("click", async () => {
  await invoke("reset_timer");
  setStatusUI(false);
  const remaining = await invoke<number>("get_remaining");
  updateUI(remaining);
});

// ─── Backend Event Listeners ────────────────────────────────

async function init() {
  // Get initial state from backend
  const remaining = await invoke<number>("get_remaining");
  const paused = await invoke<boolean>("is_paused");
  updateUI(remaining);
  setStatusUI(paused);

  // Listen for tick events from the Rust background timer
  await listen("timer-tick", async () => {
    const rem = await invoke<number>("get_remaining");
    const p = await invoke<boolean>("is_paused");
    updateUI(rem);
    setStatusUI(p);
  });

  // Listen for break events
  await listen("break-start", () => {
    // Flash the progress ring to indicate break mode
    $progress.style.stroke = "#00d2a0";
    $progress.style.filter = "drop-shadow(0 0 12px rgba(0,210,160,0.4))";
  });

  await listen("break-end", async () => {
    const rem = await invoke<number>("get_remaining");
    updateUI(rem);
    setStatusUI(false);
  });

  // Settings
  let currentSettings = await invoke<AppSettings>("get_settings");
  TOTAL_WORK_SECS = currentSettings.work_duration_secs;
  
  $inputWork.value = String(currentSettings.work_duration_secs / 60);
  $inputBreak.value = String(currentSettings.break_duration_secs);
  $mainTitle.textContent = `${currentSettings.work_duration_secs / 60}-20-${currentSettings.break_duration_secs}`;
  
  const updateStrictIndicator = (isStrict: boolean) => {
    $strictBadge.classList.toggle("status-strict-on", isStrict);
    $strictBadge.classList.toggle("status-strict-off", !isStrict);
    $strictIndicator.textContent = `Strict: ${isStrict ? "ON" : "OFF"}`;
  };
  
  updateStrictIndicator(currentSettings.strict_mode);
  
  const handleSettingsUpdate = async () => {
    let workSecs = parseInt($inputWork.value) * 60;
    if (isNaN(workSecs) || workSecs < 60) workSecs = 60; // min 1 min
    
    let breakSecs = parseInt($inputBreak.value);
    if (isNaN(breakSecs) || breakSecs < 5) breakSecs = 5; // min 5 sec
    
    const newSettings: AppSettings = {
      strict_mode: currentSettings.strict_mode,
      work_duration_secs: workSecs,
      break_duration_secs: breakSecs,
    };
    
    currentSettings = newSettings;
    $mainTitle.textContent = `${workSecs / 60}-20-${breakSecs}`;
    updateStrictIndicator(currentSettings.strict_mode);
    
    try {
      await invoke("update_settings", { settings: newSettings });
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  $btnSaveSettings.addEventListener("click", () => {
    handleSettingsUpdate();
    $settingsModal.classList.add("hidden");
  });
  
  $btnQuitApp.addEventListener("click", () => {
    invoke("quit_app").catch(console.error);
  });
  
  let strictDebounceTimer: number | null = null;
  $strictBadge.addEventListener("click", () => {
    currentSettings.strict_mode = !currentSettings.strict_mode;
    updateStrictIndicator(currentSettings.strict_mode);
    
    if (strictDebounceTimer) {
      window.clearTimeout(strictDebounceTimer);
    }
    
    strictDebounceTimer = window.setTimeout(() => {
      invoke("update_settings", { settings: currentSettings }).catch((err) => {
        console.error("Failed to update strict mode:", err);
      });
    }, 500);
  });

  // Modal logic
  $btnOpenSettings.addEventListener("click", () => {
    $settingsModal.classList.remove("hidden");
  });

  $btnCloseSettings.addEventListener("click", () => {
    $settingsModal.classList.add("hidden");
  });

  $settingsModal.addEventListener("click", (e) => {
    if (e.target === $settingsModal) {
      $settingsModal.classList.add("hidden");
    }
  });

  await listen<AppSettings>("settings-changed", (event) => {
    const s = event.payload;
    currentSettings = s;
    TOTAL_WORK_SECS = s.work_duration_secs;
    $inputWork.value = String(s.work_duration_secs / 60);
    $inputBreak.value = String(s.break_duration_secs);
    $mainTitle.textContent = `${s.work_duration_secs / 60}-20-${s.break_duration_secs}`;
    updateStrictIndicator(s.strict_mode);
  });
}

init();

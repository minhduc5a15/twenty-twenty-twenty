import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Constants ──────────────────────────────────────────────

const TOTAL_WORK_SECS = 20 * 60; // 20 minutes
const CIRCUMFERENCE = 2 * Math.PI * 88; // matches SVG circle r=88

// ─── DOM Elements ───────────────────────────────────────────

const $minutes = document.getElementById("timer-minutes") as HTMLSpanElement;
const $seconds = document.getElementById("timer-seconds") as HTMLSpanElement;
const $progress = document.getElementById("timer-progress") as unknown as SVGCircleElement;
const $statusBadge = document.getElementById("status-badge") as HTMLDivElement;
const $statusText = document.getElementById("status-text") as HTMLSpanElement;
const $btnPause = document.getElementById("btn-pause") as HTMLButtonElement;
const $btnPauseText = document.getElementById("btn-pause-text") as HTMLSpanElement;
const $iconPause = document.getElementById("icon-pause") as unknown as SVGElement;
const $iconPlay = document.getElementById("icon-play") as unknown as SVGElement;
const $btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const $infoCountdown = document.getElementById("info-countdown") as HTMLElement;
const $toggleStrictMode = document.getElementById("toggle-strict-mode") as HTMLInputElement;

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
  const isStrict = await invoke<boolean>("get_strict_mode");
  $toggleStrictMode.checked = isStrict;
  
  $toggleStrictMode.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement;
    try {
      await invoke("set_strict_mode", { strictMode: target.checked });
    } catch (err) {
      console.error("Failed to set strict mode:", err);
    }
  });

  await listen<boolean>("settings-changed", (event) => {
    $toggleStrictMode.checked = event.payload;
  });

  // Also poll every second for UI smoothness
  // (covers cases where events might be missed during window focus changes)
  setInterval(async () => {
    try {
      const rem = await invoke<number>("get_remaining");
      const p = await invoke<boolean>("is_paused");
      updateUI(rem);
      setStatusUI(p);
    } catch {
      // Ignore errors during window transitions
    }
  }, 1000);
}

init();

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Constants ──────────────────────────────────────────────

interface AppSettings {
  strict_mode: boolean;
  work_duration_secs: number;
  break_duration_secs: number;
}
const CIRCUMFERENCE = 2 * Math.PI * 70; // matches SVG circle r=70

// ─── DOM Elements ───────────────────────────────────────────

const $breakSeconds = document.getElementById(
  "break-seconds",
) as HTMLSpanElement;
const $breakProgress = document.getElementById(
  "break-progress",
) as unknown as SVGCircleElement;
const $closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const $addTimeBtn = document.getElementById("add-time-btn") as HTMLButtonElement;
const $subtitle = document.getElementById("overlay-subtitle") as HTMLParagraphElement;

// ─── Block all keyboard shortcuts ───────────────────────────

const preventKeyboard = (e: KeyboardEvent) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
};

const preventContext = (e: MouseEvent) => {
  e.preventDefault();
};

function toggleStrictListeners(strict: boolean) {
  if (strict) {
    document.addEventListener("keydown", preventKeyboard, true);
    document.addEventListener("contextmenu", preventContext);
  } else {
    document.removeEventListener("keydown", preventKeyboard, true);
    document.removeEventListener("contextmenu", preventContext);
  }
}

// ─── Countdown Logic ────────────────────────────────────────

let remaining = 20;
let totalDuration = 20;

function updateBreakUI() {
  $breakSeconds.textContent = String(remaining);

  // If time was added, update the denominator so the ring smoothly adjusts!
  if (remaining > totalDuration) {
    totalDuration = remaining;
  }

  const fraction = remaining / totalDuration;
  const offset = CIRCUMFERENCE * (1 - fraction);
  $breakProgress.style.strokeDasharray = `${CIRCUMFERENCE}`;
  $breakProgress.style.strokeDashoffset = `${offset}`;

  if (remaining <= 5) {
    $breakProgress.style.stroke = "#4de6b0";
    $breakProgress.style.filter = "drop-shadow(0 0 10px rgba(77,230,176,0.4))";
  }
}

updateBreakUI();

// Sync with backend timer
listen<number>("break-tick", (event) => {
  remaining = event.payload;
  updateBreakUI();
});

// Add more time button
$addTimeBtn.addEventListener("click", async () => {
  try {
    await invoke("add_break_time");

    // Spawn floating text animation
    const floater = document.createElement("div");
    floater.textContent = "+20";
    floater.className = "float-text";

    const rect = $addTimeBtn.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() * 20 - 10);
    const y = rect.top;

    floater.style.left = `${x}px`;
    floater.style.top = `${y}px`;
    document.body.appendChild(floater);

    setTimeout(() => floater.remove(), 1000);
  } catch (err) {
    console.error("Failed to add time:", err);
  }
});

// Fetch settings to determine when to show the close button
async function initOverlay() {
  try {
    const settings = await invoke<AppSettings>("get_settings");
    toggleStrictListeners(settings.strict_mode);
    remaining = settings.break_duration_secs;
    totalDuration = settings.break_duration_secs;
    $subtitle.textContent = `Look at something 20 feet (6 meters) away for ${settings.break_duration_secs} seconds`;
    updateBreakUI();

    if (!settings.strict_mode) {
      $closeBtn.style.display = "inline-block";
      $closeBtn.classList.add("fade-in");
    } else {
      setTimeout(() => {
        $closeBtn.style.display = "inline-block";
        $closeBtn.classList.add("fade-in");
      }, settings.break_duration_secs * 1000);
    }
  } catch (err) {
    console.error("Failed to init overlay settings:", err);
  }
}
initOverlay();

// Allow closing manually if the user clicked +20s by mistake
$closeBtn.addEventListener("click", async () => {
  try {
    await invoke("close_overlay");
  } catch (err) {
    console.error("Failed to close overlay:", err);
  }
});

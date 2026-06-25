import { listen } from "@tauri-apps/api/event";

// ─── Constants ──────────────────────────────────────────────

const BREAK_DURATION = 20; // seconds
const CIRCUMFERENCE = 2 * Math.PI * 70; // matches SVG circle r=70

// ─── DOM Elements ───────────────────────────────────────────

const $breakSeconds = document.getElementById(
  "break-seconds",
) as HTMLSpanElement;
const $breakProgress = document.getElementById(
  "break-progress",
) as unknown as SVGCircleElement;

// ─── Block all keyboard shortcuts ───────────────────────────

document.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  },
  true,
);

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// ─── Countdown Logic ────────────────────────────────────────

let remaining = BREAK_DURATION;

function updateBreakUI() {
  $breakSeconds.textContent = String(remaining);

  const fraction = remaining / BREAK_DURATION;
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

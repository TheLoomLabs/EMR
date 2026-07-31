// Deciding the EMR window's rectangle (ADR-0010, issue #21) — a pure function of the available
// screen and any remembered geometry (persisted as a `WindowRect`, utils/store.ts). entrypoints/
// background.ts (first open) and entrypoints/window/main.ts (self-correcting once its own
// `window.screen` is known) are the thin shells around it; `windows.create` and `windows.update`
// do the rest.

export interface ScreenMetrics {
  width: number;
  height: number;
}

export interface WindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const WIDTH_FRACTION = 0.7;
const HEIGHT_FRACTION = 0.75;

export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;
export const MAX_WINDOW_WIDTH = 1600;
export const MAX_WINDOW_HEIGHT = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A remembered rectangle (issue #21: "reopening wherever it was last left") is restored
 * verbatim — the screen is not consulted at all. With nothing remembered, the window is sized
 * as a fraction of the screen, clamped to a sensible minimum and maximum so an unusual screen
 * never produces an unusable window, and centred on it. */
export function planWindowRect(screen: ScreenMetrics, remembered?: WindowRect): WindowRect {
  if (remembered) return remembered;

  const width = Math.round(clamp(screen.width * WIDTH_FRACTION, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH));
  const height = Math.round(clamp(screen.height * HEIGHT_FRACTION, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT));
  const left = Math.round((screen.width - width) / 2);
  const top = Math.round((screen.height - height) / 2);

  return { left, top, width, height };
}

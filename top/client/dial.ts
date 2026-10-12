/** A dial sweeps 240 degrees, symmetric around straight up, with a ladder of ticks along it. */
export const SWEEP = 240;
export const TICKS = 51;
export const MAJOR_EVERY = 5;

/** Where tick `index` sits on the 0-100 scale. */
export function tickPercent(index: number): number {
  return (index / (TICKS - 1)) * 100;
}

/** Degrees clockwise from straight up for a 0-100 value; an unknown value rests at the start. */
export function needleDegrees(percent: number | null): number {
  const clamped = Math.min(100, Math.max(0, percent ?? 0));
  return (clamped / 100) * SWEEP - SWEEP / 2;
}

/** Bar heights as 0-1 fractions of `scale`, oldest first; unknown samples are 0. */
export function sparkHeights(values: readonly (number | null)[], scale: number): number[] {
  return values.map((value) => (value === null || scale <= 0 ? 0 : Math.min(1, value / scale)));
}

/** A screen reader gets no current value for an unknown reading, rather than a false zero. */
export function accessibilityValue(percent: number | null): {
  min: number;
  max: number;
  now?: number;
} {
  return percent === null ? { min: 0, max: 100 } : { min: 0, max: 100, now: Math.round(percent) };
}

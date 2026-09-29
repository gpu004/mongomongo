/**
 * Truncation.
 *
 * Lengths are counted in Unicode code points, not UTF-16 code units, so an
 * emoji or an astral-plane letter is never cut in half. Text that fits is
 * returned unchanged; otherwise it is cut so that, with a trailing ellipsis,
 * the result is exactly `max` code points long. A limit of zero yields the
 * empty string. The limit must be a non-negative integer.
 */

export const ELLIPSIS = "\u2026";

/** Splits text into code points. */
export function codePoints(text: string): string[] {
  const points: string[] = [];
  for (const point of text) {
    points.push(point);
  }
  return points;
}

/** Rejects limits that are negative or not whole numbers. */
export function checkLimit(max: number): void {
  if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
    throw new RangeError("max must be a non-negative integer");
  }
}

export function truncate(text: string, max: number): string {
  checkLimit(max);
  const points = codePoints(text);
  if (points.length <= max) {
    return text;
  }
  if (max === 0) {
    return "";
  }
  const kept: string[] = [];
  for (let index = 0; index < max - 1; index = index + 1) {
    kept.push(points[index]!);
  }
  return kept.join("") + ELLIPSIS;
}

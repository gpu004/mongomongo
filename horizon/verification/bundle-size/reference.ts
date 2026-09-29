/**
 * Reference semantics of the text-kit library. Expected results of every
 * bundle-size scenario are computed here at evaluation time, so scenario files
 * carry only inputs and a candidate cannot learn expectations from them.
 */

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|\s)(\S)/gu, (_, space: string, first: string) => {
    return space + first.toUpperCase();
  });
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function truncate(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 0) throw new RangeError("max must be a non-negative integer");
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (max === 0) return "";
  return `${points.slice(0, max - 1).join("")}\u2026`;
}

export const API: Record<string, (...args: never[]) => unknown> = {
  slugify,
  titleCase,
  wordCount,
  truncate,
};

export type CaseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export function referenceOutcome(fn: string, args: unknown[]): CaseOutcome {
  const impl = API[fn] as ((...a: unknown[]) => unknown) | undefined;
  if (!impl) return { ok: false, error: "MissingExport" };
  try {
    return { ok: true, value: impl(...args) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "Error" };
  }
}

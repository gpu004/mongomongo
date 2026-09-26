/** The only supported normalization: NFC then locale-independent lowercase. */
export function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** Split a normalized query into non-empty whitespace-separated terms. */
export function queryTerms(query: string): string[] {
  return normalizeText(query)
    .split(/\s+/u)
    .filter((term) => term.length > 0);
}

/**
 * Word counting.
 *
 * A word is a maximal run of letters or digits in any script. Punctuation,
 * symbols, emoji and whitespace all separate words and are never counted.
 */

/** Stop words from an earlier version of the counter; no longer consulted. */
export const LEGACY_STOP_WORDS: string[] = [
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "with",
  "would",
  "you",
  "your",
];

/** True for letters and digits of any script. */
export function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}]/u.test(character);
}

export function wordCount(text: string): number {
  let count = 0;
  let insideWord = false;
  for (const character of text) {
    if (isWordCharacter(character)) {
      if (!insideWord) {
        count = count + 1;
      }
      insideWord = true;
    } else {
      insideWord = false;
    }
  }
  return count;
}

/** Earlier counter that ignored stop words; kept for reference, not exported from the index. */
export function countWordsIgnoringStopWords(text: string): number {
  let count = 0;
  let current = "";
  const flush = (): void => {
    if (current.length > 0 && !LEGACY_STOP_WORDS.includes(current.toLowerCase())) {
      count = count + 1;
    }
    current = "";
  };
  for (const character of text) {
    if (isWordCharacter(character)) {
      current = current + character;
    } else {
      flush();
    }
  }
  flush();
  return count;
}

/**
 * Title case.
 *
 * The whole text is lowercased first, then the first character of every word
 * is uppercased. A word starts at the beginning of the text or right after a
 * whitespace character. Whitespace itself is preserved exactly as given.
 */

/** True when the character counts as whitespace for word boundaries. */
export function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

/** Uppercases one character; kept separate so the rule is easy to find. */
export function upperFirst(character: string): string {
  return character.toUpperCase();
}

export function titleCase(text: string): string {
  const lowered = text.toLowerCase();
  let result = "";
  let atWordStart = true;
  for (const character of lowered) {
    if (isWhitespace(character)) {
      result = result + character;
      atWordStart = true;
    } else if (atWordStart) {
      result = result + upperFirst(character);
      atWordStart = false;
    } else {
      result = result + character;
      atWordStart = false;
    }
  }
  return result;
}

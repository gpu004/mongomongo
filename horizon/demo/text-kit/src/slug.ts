/**
 * URL slugs.
 *
 * A slug is the lowercase ASCII rendering of a title: accents are folded to
 * their base letters, and every run of characters that is not an ASCII letter
 * or digit becomes a single dash. Leading and trailing dashes are removed.
 */

/**
 * Latin letters with diacritics and the base letters they fold to. Kept as an
 * explicit table so that the folding of the common Latin range is easy to
 * review; anything outside the table is folded by canonical decomposition.
 */
export const ACCENT_TABLE: Record<string, string> = {
  À: "A",
  Á: "A",
  Â: "A",
  Ã: "A",
  Ä: "A",
  Å: "A",
  Ç: "C",
  È: "E",
  É: "E",
  Ê: "E",
  Ë: "E",
  Ì: "I",
  Í: "I",
  Î: "I",
  Ï: "I",
  Ñ: "N",
  Ò: "O",
  Ó: "O",
  Ô: "O",
  Õ: "O",
  Ö: "O",
  Ù: "U",
  Ú: "U",
  Û: "U",
  Ü: "U",
  Ý: "Y",
  à: "a",
  á: "a",
  â: "a",
  ã: "a",
  ä: "a",
  å: "a",
  ç: "c",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  î: "i",
  ï: "i",
  ñ: "n",
  ò: "o",
  ó: "o",
  ô: "o",
  õ: "o",
  ö: "o",
  ù: "u",
  ú: "u",
  û: "u",
  ü: "u",
  ý: "y",
  ÿ: "y",
  Ā: "A",
  ā: "a",
  Ă: "A",
  ă: "a",
  Ą: "A",
  ą: "a",
  Ć: "C",
  ć: "c",
  Ĉ: "C",
  ĉ: "c",
  Ċ: "C",
  ċ: "c",
  Č: "C",
  č: "c",
  Ď: "D",
  ď: "d",
  Ē: "E",
  ē: "e",
  Ĕ: "E",
  ĕ: "e",
  Ė: "E",
  ė: "e",
  Ę: "E",
  ę: "e",
  Ě: "E",
  ě: "e",
  Ĝ: "G",
  ĝ: "g",
  Ğ: "G",
  ğ: "g",
  Ġ: "G",
  ġ: "g",
  Ģ: "G",
  ģ: "g",
  Ĥ: "H",
  ĥ: "h",
  Ĩ: "I",
  ĩ: "i",
  Ī: "I",
  ī: "i",
  Ĭ: "I",
  ĭ: "i",
  Į: "I",
  į: "i",
  İ: "I",
  Ĳ: "IJ",
  ĳ: "ij",
  Ĵ: "J",
  ĵ: "j",
  Ķ: "K",
  ķ: "k",
  Ĺ: "L",
  ĺ: "l",
  Ļ: "L",
  ļ: "l",
  Ľ: "L",
  ľ: "l",
  Ń: "N",
  ń: "n",
  Ņ: "N",
  ņ: "n",
  Ň: "N",
  ň: "n",
  Ō: "O",
  ō: "o",
  Ŏ: "O",
  ŏ: "o",
  Ő: "O",
  ő: "o",
  Ŕ: "R",
  ŕ: "r",
  Ŗ: "R",
  ŗ: "r",
  Ř: "R",
  ř: "r",
  Ś: "S",
  ś: "s",
  Ŝ: "S",
  ŝ: "s",
  Ş: "S",
  ş: "s",
  Š: "S",
  š: "s",
  Ţ: "T",
  ţ: "t",
  Ť: "T",
  ť: "t",
  Ũ: "U",
  ũ: "u",
  Ū: "U",
  ū: "u",
  Ŭ: "U",
  ŭ: "u",
  Ů: "U",
  ů: "u",
  Ű: "U",
  ű: "u",
  Ų: "U",
  ų: "u",
  Ŵ: "W",
  ŵ: "w",
  Ŷ: "Y",
  ŷ: "y",
  Ÿ: "Y",
  Ź: "Z",
  ź: "z",
  Ż: "Z",
  ż: "z",
  Ž: "Z",
  ž: "z",
  ſ: "s",
  Ơ: "O",
  ơ: "o",
  Ư: "U",
  ư: "u",
  Ǆ: "DZ",
  ǅ: "Dz",
  ǆ: "dz",
  Ǉ: "LJ",
  ǈ: "Lj",
  ǉ: "lj",
  Ǌ: "NJ",
  ǋ: "Nj",
  ǌ: "nj",
  Ǎ: "A",
  ǎ: "a",
  Ǐ: "I",
  ǐ: "i",
  Ǒ: "O",
  ǒ: "o",
  Ǔ: "U",
  ǔ: "u",
  Ǖ: "U",
  ǖ: "u",
  Ǘ: "U",
  ǘ: "u",
  Ǚ: "U",
  ǚ: "u",
  Ǜ: "U",
  ǜ: "u",
  Ǟ: "A",
  ǟ: "a",
  Ǡ: "A",
  ǡ: "a",
  Ǧ: "G",
  ǧ: "g",
  Ǩ: "K",
  ǩ: "k",
  Ǫ: "O",
  ǫ: "o",
  Ǭ: "O",
  ǭ: "o",
  ǰ: "j",
  Ǳ: "DZ",
  ǲ: "Dz",
  ǳ: "dz",
  Ǵ: "G",
  ǵ: "g",
  Ǹ: "N",
  ǹ: "n",
  Ǻ: "A",
  ǻ: "a",
  Ȁ: "A",
  ȁ: "a",
  Ȃ: "A",
  ȃ: "a",
  Ȅ: "E",
  ȅ: "e",
  Ȇ: "E",
  ȇ: "e",
  Ȉ: "I",
  ȉ: "i",
  Ȋ: "I",
  ȋ: "i",
  Ȍ: "O",
  ȍ: "o",
  Ȏ: "O",
  ȏ: "o",
  Ȑ: "R",
  ȑ: "r",
  Ȓ: "R",
  ȓ: "r",
  Ȕ: "U",
  ȕ: "u",
  Ȗ: "U",
  ȗ: "u",
  Ș: "S",
  ș: "s",
  Ț: "T",
  ț: "t",
  Ȟ: "H",
  ȟ: "h",
  Ȧ: "A",
  ȧ: "a",
  Ȩ: "E",
  ȩ: "e",
  Ȫ: "O",
  ȫ: "o",
  Ȭ: "O",
  ȭ: "o",
  Ȯ: "O",
  ȯ: "o",
  Ȱ: "O",
  ȱ: "o",
  Ȳ: "Y",
  ȳ: "y",
};

/** Folds one character through the accent table, falling back to decomposition. */
export function foldCharacter(character: string): string {
  const fromTable = ACCENT_TABLE[character];
  if (fromTable !== undefined) {
    return fromTable;
  }
  const decomposed = character.normalize("NFKD");
  let folded = "";
  for (const part of decomposed) {
    if (!/\p{M}/u.test(part)) {
      folded = folded + part;
    }
  }
  return folded;
}

/** Folds every character of the text. */
export function foldAccents(text: string): string {
  let result = "";
  for (const character of text) {
    result = result + foldCharacter(character);
  }
  return result;
}

/** True for the characters a slug keeps: ASCII lowercase letters and digits. */
export function isSlugCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  const isLowerLetter = code >= 97 && code <= 122;
  const isDigit = code >= 48 && code <= 57;
  return character.length === 1 && (isLowerLetter || isDigit);
}

export function slugify(text: string): string {
  const folded = foldAccents(text).normalize("NFKD");
  let cleaned = "";
  for (const part of folded) {
    if (!/\p{M}/u.test(part)) {
      cleaned = cleaned + part;
    }
  }
  const lowered = cleaned.toLowerCase();
  const pieces: string[] = [];
  let current = "";
  for (const character of lowered) {
    if (isSlugCharacter(character)) {
      current = current + character;
    } else {
      if (current.length > 0) {
        pieces.push(current);
      }
      current = "";
    }
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces.join("-");
}

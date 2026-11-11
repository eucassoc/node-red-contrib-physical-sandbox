// Copied from app/src/i18n.js of ps-com (commit 615120e).
// Copied 2026-11-11, Apache-2.0 by permission of the owner (2026-11-11).
// Do not edit here: tools/check-pscom-copy.mjs compares this file with its source.
/**
 * Choosing the language, and building a string from a key. **Touches neither the DOM nor
 * localStorage.**
 *
 * So it can be tested with no device (the same split as library.js and library-store.js; the
 * part that touches the device is in i18n-dom.js).
 */

export const LANGS = ['ja', 'en'];

/** Where a missing key falls back to. **Japanese is the original**; English is a translation, and can lag. */
export const FALLBACK = 'ja';

/**
 * Decide the language to use. **A saved choice comes first.**
 *
 * Decide it from the device's language alone, and on the day a device happens to be set to
 * English, a live demo comes up in English. Make the choice stick and the accident happens only
 * once.
 *
 * **Anything but Japanese becomes English.** Whoever reads what we publish gets English by default.
 */
export function pickLang(saved, navigatorLang, forced = null) {
  // A choice comes first. **A person's choice beats anything fixed.**
  if (LANGS.includes(saved)) return saved;

  // Depending on how it was distributed, the device's language is not trusted (lang-default.js).
  // The production site's private screens exist only in Japanese, so lean it to Japanese and
  // keep them from mixing
  if (LANGS.includes(forced)) return forced;

  return String(navigatorLang ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/**
 * Look a key up and fill it in. **Missing falls back to Japanese, and failing that returns the
 * key.**
 *
 * Returning the key is what makes a gap noticeable once it is on screen. An empty string hides it.
 */
export function translate(messages, lang, key, params) {
  const text = messages?.[lang]?.[key] ?? messages?.[FALLBACK]?.[key] ?? key;

  if (!params) return text;

  // A placeholder with no value is left in place. Removing it loses what was supposed to go there
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    (name in params ? String(params[name]) : whole));
}

/**
 * An Error carrying a key. **Whoever throws it does not know the language.**
 *
 * The reason a lower layer (record.js, roundtrip.js, robot.js) threw is shown by whichever
 * screen catches it, through announce or #state. That is where it is translated.
 */
export function tError(key, params) {
  const error = new Error(key);
  error.i18nKey = key;
  error.i18nParams = params;
  return error;
}

/**
 * The DOM half of the localisation layer: translating static markup.
 *
 * The extension popup is a plain HTML document whose labels are written in the
 * source language in `public/popup.html`. Manifest V3 substitutes `__MSG_key__`
 * only in `manifest.json` and CSS — NOT in HTML — so the HTML is translated at
 * runtime instead, by marking each label with `data-i18n="<messageKey>"` and
 * walking those nodes once the language is known.
 *
 * Marking the markup this way keeps the English source visible in the file (it
 * is the fallback text if a key is ever unknown) and keeps the key list
 * checkable: `tests/i18n.test.ts` asserts that every `data-i18n` key in the HTML
 * exists in the English catalog.
 */
import { getLocale, hasMessage, t } from './index.js';

/** Set `<html lang>` to the locale in force, for a11y and for CSS. */
export function applyDocumentLanguage(doc: Document = document): void {
  doc.documentElement.lang = getLocale();
}

/**
 * Replace the text of every `[data-i18n]` element under `root`.
 *
 * Only leaf elements are marked in the popup, so `textContent` replaces just the
 * label and never drops child markup. An unknown key is reported rather than
 * swallowed (spec 5.3), and the element keeps its source-language text.
 */
export function localizeDom(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.dataset['i18n'];
    if (!key) continue;
    if (!hasMessage(key)) {
      console.warn('[Khan Timer] unknown i18n key in markup:', key);
      continue;
    }
    node.textContent = t(key);
  }
}

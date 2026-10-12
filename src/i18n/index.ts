/**
 * Runtime localisation: locale resolution, message lookup and interpolation.
 *
 * Design (decided with the maintainer):
 *  - ENGLISH is the source catalog and the fallback language: the extension's
 *    primary audience is English speaking, and a key that is missing from a
 *    translation falls back to English rather than to a blank.
 *  - `en.ts` owns the key set (`MessageKey` is derived from it) and every other
 *    catalog is typed against it, so adding a language cannot silently ship
 *    untranslated labels.
 *  - The user picks a language in the popup: `auto` follows the browser UI
 *    language, or a specific locale can be forced. That override is the reason
 *    this module exists instead of using `chrome.i18n.getMessage` everywhere:
 *    Chrome's own catalogue cannot be forced to a locale, and it is absent in
 *    the unit tests.
 *
 * This module is deliberately DOM-free and `chrome.*`-optional so it stays
 * unit-testable (spec 5.3); the DOM half lives in `dom.ts`.
 */
import { en, type MessageKey } from './en.js';
import { zhCN } from './zh-CN.js';
import type { LanguageSetting, Locale } from '../types.js';

export { en, type MessageKey };

/**
 * Language used when the browser asks for a language we do not ship, and the
 * fallback for any individual key missing from a translation.
 */
export const FALLBACK_LOCALE: Locale = 'en';

/** Values interpolated into `{placeholders}`. */
export type MessageParams = Record<string, string | number | undefined>;

/**
 * Message keys that exist ONLY as `_one` / `_other` (or `_few`, `_many`, …)
 * siblings, derived from the source catalog rather than listed by hand: adding a
 * plural message to `en.ts` immediately makes its base name callable here, and a
 * base name with no siblings is rejected by the compiler.
 */
type PluralBase<K extends string> = K extends `${infer Base}_one` | `${infer Base}_other`
  ? Base
  : never;
export type PluralKey = PluralBase<MessageKey>;

/** Anything `t()` accepts: a plain message or a plural base. */
export type TranslatableKey = MessageKey | PluralKey;

/**
 * The shipped catalogs, keyed by locale.
 *
 * This is the registry everything else derives from: `Record<Locale, …>` means
 * adding a locale to the `Locale` union without adding its catalog fails the
 * typecheck, and `SUPPORTED_LOCALES` below is read straight off it so the two can
 * never disagree. Adding a language is: a catalog file, an entry here, and a
 * prefix rule in `normalizeLocale`.
 */
const CATALOGS: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-CN': zhCN,
};

/** Every language the extension ships, derived from the catalog registry. */
export const SUPPORTED_LOCALES = Object.keys(CATALOGS) as readonly Locale[];

/** The locale in force, or null until one has been resolved. */
let activeLocale: Locale | null = null;

/** Cached `Intl.PluralRules`, because `t()` runs inside the render loop. */
const pluralRulesCache = new Map<string, Intl.PluralRules>();

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Is this a real message key?
 *
 * Used where a key arrives as a string from outside the type system — the
 * `data-i18n` attributes in the popup's HTML. `hasOwnProperty` rather than `in`,
 * because `key in en` is true for inherited names such as `toString`.
 */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

/**
 * Map a BCP-47 tag onto a shipped locale.
 *
 * Region is deliberately dropped: `en-US`, `en-GB` and `en` all render the same
 * catalog, and `zh-Hans-CN` / `zh-TW` both land on the Simplified catalog, which
 * is the only Chinese one shipped. A tag for a language we do not ship returns
 * null so the caller can fall back explicitly.
 */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return null;
}

/**
 * The language of the browser itself.
 *
 * `chrome.i18n.getUILanguage()` is the extension's own view of the UI language
 * and is preferred; `navigator.language` covers the unit tests and any context
 * where the extension API is missing.
 */
export function detectLocale(): Locale {
  return (
    normalizeLocale(chromeUiLanguage()) ??
    normalizeLocale(typeof navigator !== 'undefined' ? navigator.language : null) ??
    FALLBACK_LOCALE
  );
}

/** Turn the stored setting into a concrete locale. `auto` follows the browser. */
export function resolveLocale(setting: LanguageSetting | null | undefined): Locale {
  return isLocale(setting) ? setting : detectLocale();
}

/** The locale in force. Resolved from the browser on first use. */
export function getLocale(): Locale {
  if (activeLocale === null) activeLocale = detectLocale();
  return activeLocale;
}

/**
 * Apply the stored language setting. Returns the locale that is now in force,
 * so callers can re-render only when it actually changed.
 */
export function setLocale(setting: LanguageSetting | null | undefined): Locale {
  activeLocale = resolveLocale(setting);
  return activeLocale;
}

/**
 * Look a message up and interpolate its placeholders.
 *
 * A message whose English template carries `_one` / `_other` siblings is
 * selected by `Intl.PluralRules` whenever a numeric `count` is passed. The
 * lookup tries the category the locale asks for, then `_other` in the same
 * catalog, then `_other` in English — so a language with more categories than
 * its catalog defines (`_few`, `_many`, …) still renders a sensible sentence
 * rather than a raw key.
 *
 * An unknown key returns the key itself, which makes a typo visible on screen
 * instead of rendering nothing at all.
 */
export function t(key: TranslatableKey, params?: MessageParams): string {
  const template = lookup(key, getLocale(), params);
  if (template === null) return key;
  return interpolate(template, params);
}

/**
 * A message chosen now but rendered when it is displayed.
 *
 * The controller keeps its status line and its warning in this form rather than
 * as a finished string: they stay on screen for a long time, and a learner who
 * switches language in the popup must not be left reading the old one until the
 * next detection event happens to replace it.
 */
export interface MessageRef {
  key: TranslatableKey;
  params?: MessageParams;
}

/** Resolve a `MessageRef` in the locale in force right now. */
export function render(ref: MessageRef): string {
  return t(ref.key, ref.params);
}

function lookup(key: TranslatableKey, locale: Locale, params?: MessageParams): string | null {
  const catalog: Record<string, string> = CATALOGS[locale];
  const fallback: Record<string, string> = CATALOGS[FALLBACK_LOCALE];
  const count = params?.['count'];

  if (typeof count === 'number') {
    const rules = pluralRules(locale);
    if (rules) {
      for (const suffix of [rules.select(count), 'other']) {
        const text = read(catalog, `${key}_${suffix}`) ?? read(fallback, `${key}_${suffix}`);
        if (text !== undefined) return text;
      }
    }
  }
  return read(catalog, key) ?? read(fallback, key) ?? null;
}

/**
 * Index a catalog by a key built at runtime (`…_one`, `…_other`).
 *
 * The cast is what keeps "this key may not exist" honest: `Record<MessageKey,
 * string>` would otherwise claim every string is present, and an inherited name
 * such as `toString` would be reported as a message.
 */
function read(catalog: Record<string, string>, key: string): string | undefined {
  const table = catalog as Partial<Record<string, string>>;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function pluralRules(locale: Locale): Intl.PluralRules | null {
  if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function') return null;
  const cached = pluralRulesCache.get(locale);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale);
  pluralRulesCache.set(locale, rules);
  return rules;
}

/** Replace `{name}` with the matching parameter; unknown placeholders stay put. */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** `chrome.i18n.getUILanguage()`, or null where the extension API is absent. */
function chromeUiLanguage(): string | null {
  try {
    const api = typeof chrome !== 'undefined' ? chrome : undefined;
    return api?.i18n?.getUILanguage?.() ?? null;
  } catch {
    return null;
  }
}

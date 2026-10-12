/**
 * Localisation tests.
 *
 * The catalogs are typed against each other, so `pnpm typecheck` already rejects
 * a translation that is missing a key. What the compiler cannot see is checked
 * here:
 *
 *  - the `data-i18n` keys in the shipped popup markup exist, and the English
 *    text written beside them still matches the catalog (the markup is the
 *    fallback, so it must not drift);
 *  - no translation is empty, and none is a copy of the English source by
 *    accident;
 *  - plural forms are chosen by the language's own rules, not by a hard-coded
 *    "add an s";
 *  - the browser's language is followed, and anything unsupported lands on the
 *    English fallback;
 *  - a stored message is rendered in the locale in force when it is PAINTED,
 *    which is what keeps an open panel from going stale after a language change.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  en,
  getLocale,
  hasMessage,
  normalizeLocale,
  render,
  resolveLocale,
  setLocale,
  t,
  type MessageKey,
} from '../src/i18n/index.js';
import { zhCN } from '../src/i18n/zh-CN.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/storage.js';
import type { LanguageSetting } from '../src/types.js';

const HTML = readFileSync(resolve(process.cwd(), 'public/popup.html'), 'utf8');

afterEach(() => {
  // These tests switch language on purpose; leave the module as they found it.
  setLocale('auto');
});

/* ------------------------------------------------------------------ *
 * Catalog integrity
 * ------------------------------------------------------------------ */

describe('message catalogs', () => {
  const keys = Object.keys(en) as MessageKey[];

  it('has a substantial source catalog', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it('defines every source key in every shipped language', () => {
    const catalogs: Array<[string, Record<string, string>]> = [['zh-CN', zhCN]];
    for (const [locale, catalog] of catalogs) {
      const missing = keys.filter((key) => typeof catalog[key] !== 'string');
      expect(missing, `${locale} is missing keys`).toEqual([]);
      // ...and nothing beyond them, so a key deleted from the source does not
      // linger as dead weight in a translation.
      expect(Object.keys(catalog).sort()).toEqual([...keys].sort());
    }
  });

  it('never ships an empty message', () => {
    for (const key of keys) {
      expect(en[key].length, `en: ${key}`).toBeGreaterThan(0);
    }
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      expect(zhCN[key].length, `zh-CN: ${key}`).toBeGreaterThan(0);
    }
  });

  it('has actually been translated, not copied', () => {
    // "ID" is the same abbreviation in both languages; everything else that is
    // still byte-identical to English is an untranslated string.
    const identicalByDesign = new Set<MessageKey>(['popup.shortKeyId']);
    const copied = keys.filter(
      (key) => !identicalByDesign.has(key) && zhCN[key] === en[key],
    );
    expect(copied).toEqual([]);
  });

  it('keeps the placeholders of a translation in step with the source', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    const mismatched = keys.filter(
      (key) => placeholders(en[key]).join() !== placeholders(zhCN[key]).join(),
    );
    expect(mismatched).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Lookup, interpolation, plurals
 * ------------------------------------------------------------------ */

describe('t()', () => {
  it('selects the plural form each language asks for', () => {
    setLocale('en');
    expect(t('summary.totalAll', { count: 1, total: '0:30' })).toBe('1 question · 0:30 total');
    expect(t('summary.totalAll', { count: 4, total: '0:30' })).toBe('4 questions · 0:30 total');
    expect(t('popup.savedCount', { count: 1 })).toBe('1 record saved');
    expect(t('popup.savedCount', { count: 7 })).toBe('7 records saved');

    setLocale('zh-CN');
    // Chinese has a single plural category, so one count reads like any other.
    expect(t('summary.totalAll', { count: 1, total: '0:30' })).toBe('共 1 题 · 合计 0:30');
    expect(t('summary.totalAll', { count: 4, total: '0:30' })).toBe('共 4 题 · 合计 0:30');
    expect(t('popup.savedCount', { count: 1 })).toBe('已保存 1 条');
  });

  it('interpolates every placeholder it is given', () => {
    setLocale('en');
    expect(t('summary.paused', { duration: '0:05' })).toBe('Paused 0:05');
    expect(t('warning.uncertainPaused', { reason: 'no-region' })).toContain('(no-region)');
  });

  it('leaves a placeholder it was not given visible rather than blank', () => {
    setLocale('en');
    // A missing parameter is a bug; showing it as one beats rendering
    // "Question " with no number.
    expect(t('summary.questionNumber')).toContain('{number}');
  });

  it('only recognises real keys, including inherited names', () => {
    expect(hasMessage('overlay.pause')).toBe(true);
    expect(hasMessage('overlay.nope')).toBe(false);
    // `key in en` would have said yes to this one.
    expect(hasMessage('toString')).toBe(false);
  });

  it('renders a stored reference in the locale in force at paint time', () => {
    // This is the property the controller relies on for its status line: the
    // message is chosen once and painted many times.
    const ref = { key: 'overlay.pause' } as const;
    setLocale('en');
    expect(render(ref)).toBe('Pause');
    setLocale('zh-CN');
    expect(render(ref)).toBe('暂停');
  });
});

/* ------------------------------------------------------------------ *
 * Locale resolution
 * ------------------------------------------------------------------ */

describe('locale resolution', () => {
  it('maps regional variants onto the catalogs it ships', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en-GB')).toBe('en');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-CN');
    expect(normalizeLocale('de-DE')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale('')).toBeNull();
  });

  it('honours an explicit choice, and follows the browser for "auto"', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('auto')).toBe(detectLocale());
    // A value from a newer version, or a corrupted store, is not a locale.
    expect(resolveLocale('de' as LanguageSetting)).toBe(detectLocale());
    expect(SUPPORTED_LOCALES).toContain(detectLocale());
  });

  it('falls back to English for a language it does not ship', () => {
    const original = window.navigator.language;
    Object.defineProperty(window.navigator, 'language', { value: 'de-DE', configurable: true });
    try {
      expect(detectLocale()).toBe(FALLBACK_LOCALE);
      expect(setLocale('auto')).toBe(FALLBACK_LOCALE);
    } finally {
      Object.defineProperty(window.navigator, 'language', { value: original, configurable: true });
      setLocale('auto');
    }
  });

  it('applies the stored setting rather than only reporting it', () => {
    expect(setLocale('zh-CN')).toBe('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(t('overlay.pause')).toBe('暂停');
    expect(setLocale('en')).toBe('en');
    expect(getLocale()).toBe('en');
    expect(t('overlay.pause')).toBe('Pause');
  });
});

/* ------------------------------------------------------------------ *
 * The language setting
 * ------------------------------------------------------------------ */

describe('the language setting', () => {
  it('defaults to following the browser', () => {
    expect(DEFAULT_SETTINGS.language).toBe('auto');
  });

  it('accepts a shipped locale and normalises anything else to "auto"', () => {
    expect(sanitizeSettings({ language: 'zh-CN' }).language).toBe('zh-CN');
    expect(sanitizeSettings({ language: 'en' }).language).toBe('en');
    expect(sanitizeSettings({ language: 'de' }).language).toBe('auto');
    expect(sanitizeSettings({ language: 42 }).language).toBe('auto');
    // A settings object written before the language setting existed has no
    // migration step to run: it simply resolves to "follow the browser".
    const legacy = sanitizeSettings({ defaultMode: 'countdown', soundEnabled: false });
    expect(legacy.language).toBe('auto');
    expect(legacy.defaultMode).toBe('countdown');
  });
});

/* ------------------------------------------------------------------ *
 * The shipped popup markup
 * ------------------------------------------------------------------ */

describe('popup markup', () => {
  const parsed = new DOMParser().parseFromString(HTML, 'text/html');
  const marked = [...parsed.querySelectorAll<HTMLElement>('[data-i18n]')];

  it('marks every label it shows through the catalog', () => {
    expect(marked.length).toBeGreaterThan(20);
    const unknown = marked
      .map((node) => node.dataset['i18n'] ?? '')
      .filter((key) => !hasMessage(key));
    expect(unknown).toEqual([]);
  });

  it('writes the English catalog text beside each key, as the fallback', () => {
    const mismatched = marked
      .map((node) => {
        const key = node.dataset['i18n'] as MessageKey;
        return { key, markup: (node.textContent ?? '').trim(), catalog: en[key] };
      })
      .filter((entry) => entry.markup !== entry.catalog)
      .map((entry) => `${entry.key}: markup "${entry.markup}" vs catalog "${entry.catalog}"`);
    expect(mismatched).toEqual([]);
  });

  it('never marks an element that contains other markup', () => {
    // `localizeDom` writes `textContent`, so a marked node must be a leaf or the
    // translation would delete its children.
    const withChildren = marked
      .filter((node) => node.children.length > 0)
      .map((node) => node.dataset['i18n'] ?? '');
    expect(withChildren).toEqual([]);
  });
});

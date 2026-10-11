/**
 * Popup "历史记录" section.
 *
 * Two rules are covered here:
 *  - The clear-all control is only rendered when there is something to clear:
 *    an empty panel must not offer a danger button that cannot do anything.
 *  - One-shot feedback appears in the card that owns the control (records vs.
 *    settings), so a clearing result is never reported inside 设置.
 *
 * The real `public/popup.html` + `public/popup.css` are loaded here so the test
 * covers the shipped markup and stylesheet, not a hand-written fixture.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionRecord } from '../src/types.js';

// vitest serves modules over http in the jsdom environment, so resolve the
// shipped popup files from the project root instead of `import.meta.url`.
const HTML = readFileSync(resolve(process.cwd(), 'public/popup.html'), 'utf8');
const CSS = readFileSync(resolve(process.cwd(), 'public/popup.css'), 'utf8');

type Store = Record<string, unknown>;

let store: Store;
/** Injected storage failures, for the degraded paths of spec 5.3. */
let failWrite: boolean;
let failRemove: boolean;

function makeRecord(): QuestionRecord {
  const now = Date.now();
  return {
    id: 'r_1',
    questionKey: 'id:abc123',
    exerciseKey: 'exercise-1',
    startedAt: now,
    endedAt: now + 5000,
    durationMs: 5000,
    pausedMs: 0,
    mode: 'countup',
    limitMs: null,
    timedOut: false,
    firstSubmissionAt: null,
    firstSubmissionOutcome: null,
    endReason: 'question-change',
    status: 'completed',
    detectionConfidence: 'stable-id',
    wasPaused: false,
    runId: 'run_1',
    questionIndex: 1,
    questionTotal: 4,
  };
}

/** Minimal async `chrome.storage.local` over a plain object. */
function installChrome(): void {
  const fake = {
    runtime: { getManifest: () => ({ version: '0.0.0-test' }) },
    // No active tab: the popup must still render settings and records.
    tabs: { query: async () => [] },
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          if (keys === null || keys === undefined) return { ...store };
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out: Store = {};
          for (const key of wanted) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (items: Store) => {
          if (failWrite) throw new Error('storage write failed');
          Object.assign(store, items);
        },
        remove: async (keys: string | string[]) => {
          if (failRemove) throw new Error('storage remove failed');
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
    },
  };
  globalThis.chrome = fake as unknown as typeof chrome;
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Load a fresh popup document and boot the real popup bundle against it. */
async function bootPopup(): Promise<void> {
  const parsed = new DOMParser().parseFromString(HTML, 'text/html');
  document.head.innerHTML = `<style>${CSS}</style>`;
  document.body.innerHTML = parsed.body.innerHTML;

  vi.resetModules();
  installChrome();
  await import('../src/popup.js');
  await flush();
}

const clearButton = (): HTMLButtonElement => {
  const node = document.getElementById('clear-records');
  if (!node) throw new Error('missing #clear-records');
  return node as HTMLButtonElement;
};

const countLabel = (): string => document.getElementById('record-count')?.textContent ?? '';

const hint = (id: string): HTMLParagraphElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as HTMLParagraphElement;
};

/** Visible to the user: not `hidden`, and not hidden by CSS either. */
const isVisible = (node: HTMLElement): boolean =>
  !node.hidden && window.getComputedStyle(node).display !== 'none';

const cardOf = (id: string): HTMLElement | null =>
  document.getElementById(id)?.closest('.card') ?? null;

describe('popup records section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store = {};
    failWrite = false;
    failRemove = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  it('hides the clear button when nothing has been saved', async () => {
    await bootPopup();

    expect(countLabel()).toBe('已保存 0 条');
    expect(clearButton().hidden).toBe(true);
    expect(isVisible(clearButton())).toBe(false);
  });

  it('shows the clear button once a record exists', async () => {
    store = { records: { version: 1, records: [makeRecord()] } };
    await bootPopup();

    expect(countLabel()).toBe('已保存 1 条');
    expect(clearButton().hidden).toBe(false);
    expect(isVisible(clearButton())).toBe(true);
  });

  it('hides the button again after clearing, keeping settings intact', async () => {
    store = {
      records: { version: 1, records: [makeRecord()] },
      settings: { defaultMode: 'countdown', countdownLimitSeconds: 6 },
    };
    await bootPopup();

    clearButton().click();
    await flush();

    expect(store['records']).toBeUndefined();
    expect(countLabel()).toBe('已保存 0 条');
    expect(clearButton().hidden).toBe(true);
    expect(isVisible(clearButton())).toBe(false);
    expect(store['settings']).toEqual({ defaultMode: 'countdown', countdownLimitSeconds: 6 });
  });

  it('reports a successful clear inside the records card, not in 设置', async () => {
    store = { records: { version: 1, records: [makeRecord()] } };
    await bootPopup();

    clearButton().click();
    await flush();

    expect(hint('records-hint').textContent).toBe('记录已清除');
    expect(isVisible(hint('records-hint'))).toBe(true);
    expect(cardOf('records-hint')?.querySelector('h2')?.textContent).toBe('历史记录');

    // The settings card must stay silent: it has no idea what was cleared.
    expect(hint('save-hint').hidden).toBe(true);
    expect(hint('save-hint').textContent).toBe('');

    // The message is a transient status line, not a permanent label.
    await vi.advanceTimersByTimeAsync(2000);
    expect(hint('records-hint').hidden).toBe(true);
  });

  it('reports a failed clear next to the button, as an error', async () => {
    store = { records: { version: 1, records: [makeRecord()] } };
    failRemove = true;
    await bootPopup();

    clearButton().click();
    await flush();

    const records = hint('records-hint');
    expect(records.textContent).toBe('清除失败：浏览器存储不可用');
    expect(isVisible(records)).toBe(true);
    expect(records.classList.contains('error')).toBe(true);
    // The error variant is actually styled, not just labelled.
    expect(CSS).toContain('.hint.error');
    expect(hint('save-hint').hidden).toBe(true);
    // A failed clear leaves the records (and the button) in place.
    expect(countLabel()).toBe('已保存 1 条');
    expect(clearButton().hidden).toBe(false);
  });

  it('keeps a settings write failure inside the settings card', async () => {
    await bootPopup();

    failWrite = true;
    const select = document.getElementById('defaultMode') as HTMLSelectElement;
    select.value = 'countdown';
    select.dispatchEvent(new Event('change'));
    await flush();

    expect(hint('save-hint').textContent).toBe('保存失败：浏览器存储不可用');
    expect(isVisible(hint('save-hint'))).toBe(true);
    expect(cardOf('save-hint')?.querySelector('h2')?.textContent).toBe('设置');
    expect(hint('records-hint').hidden).toBe(true);
  });
});

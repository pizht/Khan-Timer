/**
 * Extension action popup: live status, settings and local record management.
 *
 * Two independent data paths, deliberately:
 *  1. Settings and records are read straight from `chrome.storage.local`, so
 *     the popup is useful even when no Khan Academy tab is open.
 *  2. Live timer status is requested from the content script. If that fails
 *     (no supported page, content script not injected yet) the popup degrades
 *     to explaining why instead of showing stale numbers (spec 5.3).
 */

import {
  clearRecords,
  chromeStorageArea,
  loadRecords,
  loadSettings,
  sanitizeSettings,
  saveSettings,
  type StorageArea,
} from './storage.js';
import { formatDuration } from './timer-engine.js';
import { getLocale, setLocale, t, type MessageKey } from './i18n/index.js';
import { applyDocumentLanguage, localizeDom } from './i18n/dom.js';
import type { LanguageSetting, QuestionRecord, Settings, TimerSnapshot } from './types.js';

interface StatusResponse {
  ok: boolean;
  settings: Settings;
  url: string;
  exerciseKey: string;
  questionKey: string | null;
  display: string;
  snapshot: TimerSnapshot | null;
  savedRecords: number;
  recent: QuestionRecord[];
  diagnostics: {
    regionFound: boolean;
    strategy: string | null;
    confidence: string;
    questionKey: string | null;
    progress: string | null;
    notes: string[];
    errors: string[];
  };
  warning: string | null;
  lastEvent: string;
  /**
   * The question's clock was frozen because the page is 识别：未识别. The
   * in-page panel is hidden in that state, so the popup is where the learner
   * finds out that the clock is paused rather than stopped.
   */
  pausedForUnidentified?: boolean;
  /** The page is showing a "Let's go" intro card instead of a question. */
  startCard?: boolean;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup: missing #${id}`);
  return node as T;
};

/**
 * How the detector's confidence is described in the popup's details list.
 *
 * This is the popup's own wording, deliberately more explicit than the two-word
 * labels the floating panel has room for: the popup is where a learner comes to
 * find out WHY something is not being recognised.
 */
const CONFIDENCE_LABEL: Record<string, MessageKey> = {
  'stable-id': 'popup.confidenceStableId',
  fingerprint: 'popup.confidenceFingerprint',
  weak: 'popup.confidenceWeak',
  none: 'popup.confidenceNone',
};

let area: StorageArea | null = null;
let settings: Settings | null = null;

/**
 * A one-shot status line that lives inside the card it belongs to. Feedback
 * must appear where the control was used: a settings failure belongs in the
 * settings card, and a record-clearing result belongs in the records card.
 */
function createHint(id: string): {
  show(text: string, kind?: 'info' | 'error'): void;
} {
  let timer: number | null = null;
  return {
    show(text, kind = 'info') {
      const hint = el(id);
      hint.textContent = text;
      hint.classList.toggle('error', kind === 'error');
      hint.hidden = false;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        hint.hidden = true;
      }, 1600);
    },
  };
}

const saveHint = createHint('save-hint');
const recordsHint = createHint('records-hint');

async function main(): Promise<void> {
  area = chromeStorageArea();
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;

  settings = await loadSettings(area);
  // The stored language decides every label below, so it is applied before the
  // first paint: the markup's English text is only the source language and the
  // fallback, never what a Chinese user is meant to see.
  setLocale(settings.language);
  applyDocumentLanguage();
  localizeDom();

  paintSettings(settings);
  await paintRecords();

  wireSettingsInputs();
  wireClearButton();

  await refreshStatus();
  // Keep the popup live while it is open.
  window.setInterval(() => void refreshStatus(), 1000);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function paintSettings(current: Settings): void {
  (el<HTMLSelectElement>('language')).value = current.language;
  (el<HTMLSelectElement>('defaultMode')).value = current.defaultMode;
  (el<HTMLInputElement>('countdownLimitSeconds')).value = String(current.countdownLimitSeconds);
  (el<HTMLInputElement>('soundEnabled')).checked = current.soundEnabled;
  (el<HTMLInputElement>('overlayVisible')).checked = current.overlayVisible;
  (el<HTMLInputElement>('overlayCollapsed')).checked = current.overlayCollapsed;
  (el<HTMLInputElement>('resumeAcrossReload')).checked = current.resumeAcrossReload;
  (el<HTMLInputElement>('developerMode')).checked = current.developerMode;

  // Detection internals are opt-in: without 开发者模式 the popup shows only the
  // status line, the timer readout and the question progress row.
  document.body.classList.toggle('dev', current.developerMode);

  // Countup mode never counts down, so the per-question limit is meaningless
  // there: hide it rather than show a control that does nothing. The value is
  // kept in storage and repainted, so switching back to countdown restores it.
  el('countdown-limit-field').hidden = current.defaultMode !== 'countdown';
}

function wireSettingsInputs(): void {
  const commit = async (patch: Partial<Settings>): Promise<void> => {
    if (!settings) return;
    settings = sanitizeSettings({ ...settings, ...patch });
    paintSettings(settings);
    const ok = await saveSettings(area, settings);
    if (!ok) saveHint.show(t('popup.saveFailed'), 'error');
  };

  el<HTMLSelectElement>('language').addEventListener('change', (event) => {
    const raw = (event.target as HTMLSelectElement).value;
    const language: LanguageSetting = raw === 'en' || raw === 'zh-CN' ? raw : 'auto';
    // Re-letter the popup from the new catalog before saving it. Everything the
    // popup builds from data rather than from markup — the status line, the mode
    // tag, the last event, the record list — is repainted explicitly, because
    // `localizeDom` only walks `data-i18n` nodes.
    setLocale(language);
    applyDocumentLanguage();
    localizeDom();
    void commit({ language });
    void paintRecords();
    void refreshStatus();
  });

  el<HTMLSelectElement>('defaultMode').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    void commit({ defaultMode: value === 'countdown' ? 'countdown' : 'countup' });
  });

  el<HTMLInputElement>('countdownLimitSeconds').addEventListener('change', (event) => {
    const raw = Number((event.target as HTMLInputElement).value);
    void commit({ countdownLimitSeconds: Number.isFinite(raw) ? raw : 60 });
  });

  const bindToggle = (id: string, key: keyof Settings): void => {
    el<HTMLInputElement>(id).addEventListener('change', (event) => {
      void commit({ [key]: (event.target as HTMLInputElement).checked } as Partial<Settings>);
    });
  };
  bindToggle('soundEnabled', 'soundEnabled');
  bindToggle('overlayVisible', 'overlayVisible');
  bindToggle('overlayCollapsed', 'overlayCollapsed');
  bindToggle('resumeAcrossReload', 'resumeAcrossReload');
  bindToggle('developerMode', 'developerMode');
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

async function paintRecords(): Promise<void> {
  const records = await loadRecords(area);
  el('record-count').textContent = t('popup.savedCount', { count: records.length });
  // With nothing saved there is nothing to clear: an always-visible danger
  // button that does nothing is noise, so only offer it when it has an effect.
  el<HTMLButtonElement>('clear-records').hidden = records.length === 0;
  const list = el<HTMLUListElement>('recent');
  list.replaceChildren();

  if (records.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('popup.recordsEmpty');
    list.append(empty);
    return;
  }

  for (const record of records.slice(-10).reverse()) {
    const li = document.createElement('li');

    const left = document.createElement('span');
    left.className = 'r-time';
    left.textContent = formatDuration(record.durationMs);

    const right = document.createElement('span');
    right.className = 'r-meta';
    const bits = [
      // Formatted in the language the learner reads, not in the browser's, so
      // the clock time agrees with the labels around it.
      new Date(record.startedAt).toLocaleTimeString(getLocale(), {
        hour: '2-digit',
        minute: '2-digit',
      }),
      record.mode === 'countdown' ? t('mode.countdown') : t('mode.countup'),
    ];
    if (record.timedOut) bits.push(t('popup.recordTimedOut'));
    if (record.firstSubmissionAt !== null) {
      bits.push(
        record.firstSubmissionOutcome === 'incorrect'
          ? t('popup.recordFirstIncorrect')
          : record.firstSubmissionOutcome === 'correct'
            ? t('popup.recordFirstCorrect')
            : t('popup.recordSubmitted'),
      );
    }
    if (record.status === 'partial') bits.push(t('popup.recordPartial'));
    bits.push(recordPosition(record));
    right.textContent = bits.join(' · ');

    li.append(left, right);
    list.append(li);
  }
}

/**
 * Which question of its exercise a record is about — the tail of a history row.
 *
 * The record's own position fields come first: they are bound while the question
 * is on screen, so they are the same numbers `summary-view.ts` numbers the
 * end-of-exercise rows with. A record written before those fields existed (or one
 * whose marker was not readable when it started) carries neither, and then the
 * identity key is read instead: a progress marker states the position itself.
 *
 * Only an opaque identity falls through to `shortKey` — a hash or a fingerprint
 * does not say which question it was, so it is shown shortened.
 */
function recordPosition(record: QuestionRecord): string {
  const position = positionOf(record);
  if (position === null) return shortKey(record.questionKey);
  return position.total === null
    ? t('popup.recordPositionOnly', { number: position.number })
    : t('popup.recordPosition', { number: position.number, total: position.total });
}

/** 1-based question number and exercise size, when the record knows them. */
function positionOf(record: QuestionRecord): { number: number; total: number | null } | null {
  if (record.questionIndex !== null) {
    return { number: record.questionIndex + 1, total: record.questionTotal };
  }
  // The identity of a question keyed by the page's own progress marker:
  // `id:progress:<n> of <m>`, or `id:progress:#<n>` — the second shape is what
  // `progressLabel` produces when it has no total. Today's `readProgress` always
  // reports one (the total is the marker's cell count), so `#<n>` is tolerated
  // rather than expected: the label format allows it, and a key is data that may
  // have been written by an older build.
  const match = /^id:progress:(?:(\d+) of (\d+)|#(\d+))$/.exec(record.questionKey);
  if (!match) return null;
  const number = Number(match[1] ?? match[3]);
  if (!Number.isFinite(number)) return null;
  return { number, total: match[2] === undefined ? null : Number(match[2]) };
}

function shortKey(key: string): string {
  if (key.startsWith('id:')) return t('popup.shortKeyId', { key: key.slice(3, 15) });
  if (key.startsWith('fp:')) return t('popup.shortKeyFingerprint', { key: key.slice(3) });
  if (key.startsWith('prog:')) return key.slice(5);
  return key.slice(0, 16);
}

function wireClearButton(): void {
  el<HTMLButtonElement>('clear-records').addEventListener('click', () => {
    void (async () => {
      const ok = await clearRecords(area);
      // The result belongs next to the button that was pressed, not in the
      // settings card, which knows nothing about records.
      if (ok) recordsHint.show(t('popup.cleared'));
      else recordsHint.show(t('popup.clearFailed'), 'error');
      await paintRecords();
    })();
  });
}

/* ------------------------------------------------------------------ *
 * Live status
 * ------------------------------------------------------------------ */

async function refreshStatus(): Promise<void> {
  const statusText = el('status-text');
  try {
    const response = await requestStatus();
    if (!response) {
      statusText.textContent = t('popup.noTimerHere');
      statusText.className = 'status-value warn';
      el('details').hidden = true;
      el('readout').hidden = true;
      el('warning').hidden = true;
      el('diag-box').hidden = true;
      return;
    }
    paintStatus(response);
  } catch (error) {
    statusText.textContent = t('popup.statusUnreadable');
    statusText.className = 'status-value bad';
    el('warning').hidden = false;
    el('warning').textContent = t('popup.statusReadFailed', { message: (error as Error).message });
  }
}

async function requestStatus(): Promise<StatusResponse | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return null;
  try {
    const response = (await chrome.tabs.sendMessage(tab.id, {
      type: 'khan-timer:get-status',
    })) as StatusResponse | undefined;
    return response?.ok ? response : null;
  } catch {
    // No content script on this tab (not a supported page, or still loading).
    return null;
  }
}

function paintStatus(response: StatusResponse): void {
  const statusText = el('status-text');
  const diag = response.diagnostics;

  if (response.startCard) {
    statusText.textContent = t('popup.notStarted');
    statusText.className = 'status-value warn';
  } else if (response.pausedForUnidentified) {
    // The panel is hidden while 未识别, so say plainly that time is not being
    // counted and that the question keeps its earlier time.
    statusText.textContent = t('popup.pausedForUnidentified');
    statusText.className = 'status-value warn';
  } else if (!diag.regionFound) {
    statusText.textContent = t('popup.regionMissing');
    statusText.className = 'status-value bad';
  } else if (diag.confidence === 'none') {
    statusText.textContent = t('popup.regionOnly');
    statusText.className = 'status-value warn';
  } else if (diag.confidence === 'weak') {
    statusText.textContent = t('popup.lowConfidence');
    statusText.className = 'status-value warn';
  } else {
    statusText.textContent = t('popup.timing');
    statusText.className = 'status-value ok';
  }

  const snapshot = response.snapshot;
  el('readout').hidden = snapshot === null;
  if (snapshot) {
    el('display').textContent = response.display;
    el('mode-tag').textContent =
      snapshot.mode === 'countdown' ? t('mode.countdown') : t('mode.countup');
    const expiredTag = el('expired-tag');
    expiredTag.hidden = !snapshot.expired;
    if (snapshot.expired) {
      expiredTag.textContent = t('popup.expiredTag', {
        duration: formatDuration(snapshot.overrunMs),
      });
    }
  }

  const confidenceKey = CONFIDENCE_LABEL[diag.confidence];
  el('details').hidden = false;
  el('d-strategy').textContent = diag.strategy ?? '—';
  el('d-confidence').textContent = confidenceKey ? t(confidenceKey) : diag.confidence;
  el('d-question').textContent = shortKey(response.questionKey ?? '—');
  el('d-progress').textContent = diag.progress ?? '—';
  el('d-event').textContent = response.lastEvent || '—';

  const warning = el('warning');
  if (response.warning) {
    warning.hidden = false;
    warning.textContent = response.warning;
  } else {
    warning.hidden = true;
  }

  el('diag-box').hidden = false;
  el('diag-text').textContent = [
    `URL: ${response.url}`,
    `${t('popup.diagPractice')} ${response.exerciseKey || '—'}`,
    `${t('popup.diagQuestionKey')} ${response.questionKey ?? '—'}`,
    `${t('popup.diagRegionFound')} ${diag.regionFound}`,
    `${t('popup.diagStrategy')} ${diag.strategy ?? '—'}`,
    '',
    t('popup.diagMatchedRecords'),
    ...(diag.notes.length > 0 ? diag.notes.map((n) => `  · ${n}`) : [`  ${t('popup.diagNone')}`]),
    '',
    t('popup.diagProblems'),
    ...(diag.errors.length > 0 ? diag.errors.map((n) => `  ! ${n}`) : [`  ${t('popup.diagNone')}`]),
  ].join('\n');

  if (response.savedRecords !== undefined) {
    void paintRecords();
  }
}

main().catch((error: unknown) => {
  const statusText = document.getElementById('status-text');
  if (statusText) {
    statusText.textContent = t('popup.initFailed', { message: (error as Error).message });
    statusText.className = 'status-value bad';
  }
});

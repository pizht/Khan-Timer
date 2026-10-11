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
import type { QuestionRecord, Settings, TimerSnapshot } from './types.js';

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
  /** The page is showing a "Let's go" intro card instead of a question. */
  startCard?: boolean;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup: missing #${id}`);
  return node as T;
};

const CONFIDENCE_LABEL: Record<string, string> = {
  'stable-id': '题目 ID（强）',
  fingerprint: '题目指纹（中）',
  weak: '弱信号',
  none: '未识别',
};

let area: StorageArea | null = null;
let settings: Settings | null = null;
let saveHintTimer: number | null = null;

async function main(): Promise<void> {
  area = chromeStorageArea();
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;

  settings = await loadSettings(area);
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
  (el<HTMLSelectElement>('defaultMode')).value = current.defaultMode;
  (el<HTMLInputElement>('countdownLimitSeconds')).value = String(current.countdownLimitSeconds);
  (el<HTMLInputElement>('soundEnabled')).checked = current.soundEnabled;
  (el<HTMLInputElement>('overlayVisible')).checked = current.overlayVisible;
  (el<HTMLInputElement>('overlayCollapsed')).checked = current.overlayCollapsed;
  (el<HTMLInputElement>('resumeAcrossReload')).checked = current.resumeAcrossReload;

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
    showSaveHint(ok ? '已保存' : '保存失败：浏览器存储不可用');
  };

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
}

function showSaveHint(text: string): void {
  const hint = el('save-hint');
  hint.textContent = text;
  hint.hidden = false;
  if (saveHintTimer !== null) window.clearTimeout(saveHintTimer);
  saveHintTimer = window.setTimeout(() => {
    hint.hidden = true;
  }, 1600);
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

async function paintRecords(): Promise<void> {
  const records = await loadRecords(area);
  el('record-count').textContent = `已保存 ${records.length} 条`;
  const list = el<HTMLUListElement>('recent');
  list.replaceChildren();

  if (records.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '暂无记录。在可汗学院练习页完成一道题后会出现在这里。';
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
      new Date(record.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      record.mode === 'countdown' ? '倒计时' : '正计时',
    ];
    if (record.timedOut) bits.push('超时');
    if (record.firstSubmissionAt !== null) {
      bits.push(
        record.firstSubmissionOutcome === 'incorrect'
          ? '首次答错'
          : record.firstSubmissionOutcome === 'correct'
            ? '首次答对'
            : '已提交',
      );
    }
    if (record.status === 'partial') bits.push('未完成');
    bits.push(shortKey(record.questionKey));
    right.textContent = bits.join(' · ');

    li.append(left, right);
    list.append(li);
  }
}

function shortKey(key: string): string {
  if (key.startsWith('id:')) return `ID ${key.slice(3, 15)}`;
  if (key.startsWith('fp:')) return `指纹 ${key.slice(3)}`;
  if (key.startsWith('prog:')) return key.slice(5);
  return key.slice(0, 16);
}

function wireClearButton(): void {
  el<HTMLButtonElement>('clear-records').addEventListener('click', () => {
    void (async () => {
      const ok = await clearRecords(area);
      showSaveHint(ok ? '记录已清除' : '清除失败：浏览器存储不可用');
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
      statusText.textContent = '此标签页未运行计时器';
      statusText.className = 'status-value warn';
      el('details').hidden = true;
      el('readout').hidden = true;
      el('warning').hidden = true;
      el('diag-box').hidden = true;
      return;
    }
    paintStatus(response);
  } catch (error) {
    statusText.textContent = '无法读取页面状态';
    statusText.className = 'status-value bad';
    el('warning').hidden = false;
    el('warning').textContent = `读取失败：${(error as Error).message}`;
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
    statusText.textContent = '尚未开始：请点击页面上的「Let\u2019s go」';
    statusText.className = 'status-value warn';
  } else if (!diag.regionFound) {
    statusText.textContent = '未找到题目区域（此页面暂不支持）';
    statusText.className = 'status-value bad';
  } else if (diag.confidence === 'none') {
    statusText.textContent = '已找到题目区域，但无法识别题目';
    statusText.className = 'status-value warn';
  } else if (diag.confidence === 'weak') {
    statusText.textContent = '识别置信度较低';
    statusText.className = 'status-value warn';
  } else {
    statusText.textContent = '正在计时（已可靠识别）';
    statusText.className = 'status-value ok';
  }

  const snapshot = response.snapshot;
  el('readout').hidden = snapshot === null;
  if (snapshot) {
    el('display').textContent = response.display;
    el('mode-tag').textContent = snapshot.mode === 'countdown' ? '倒计时' : '正计时';
    const expiredTag = el('expired-tag');
    expiredTag.hidden = !snapshot.expired;
    if (snapshot.expired) {
      expiredTag.textContent = `已超时 +${formatDuration(snapshot.overrunMs)}`;
    }
  }

  el('details').hidden = false;
  el('d-strategy').textContent = diag.strategy ?? '—';
  el('d-confidence').textContent = CONFIDENCE_LABEL[diag.confidence] ?? diag.confidence;
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
    `练习标识: ${response.exerciseKey || '—'}`,
    `题目键: ${response.questionKey ?? '—'}`,
    `区域已找到: ${diag.regionFound}`,
    `选择器策略: ${diag.strategy ?? '—'}`,
    '',
    '匹配记录:',
    ...(diag.notes.length > 0 ? diag.notes.map((n) => `  · ${n}`) : ['  （无）']),
    '',
    '问题记录:',
    ...(diag.errors.length > 0 ? diag.errors.map((n) => `  ! ${n}`) : ['  （无）']),
  ].join('\n');

  if (response.savedRecords !== undefined) {
    void paintRecords();
  }
}

main().catch((error: unknown) => {
  const statusText = document.getElementById('status-text');
  if (statusText) {
    statusText.textContent = `面板初始化失败：${(error as Error).message}`;
    statusText.className = 'status-value bad';
  }
});

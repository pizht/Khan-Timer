/**
 * Local persistence for settings, timing records and in-flight sessions.
 *
 * Everything lives in `chrome.storage.local`. Nothing leaves the machine
 * (spec 6): there is no network code in this project at all.
 *
 * The `StorageArea` interface exists so tests can drive the real logic against
 * an in-memory fake, and so a storage failure becomes a described degradation
 * rather than a crash (spec 5.3).
 */

import type {
  QuestionRecord,
  Settings,
  StoredRecords,
  TimerSerialized,
} from './types.js';
import { clampNumber, isRecord, toBoolean } from './util.js';

/** Newest-last cap on retained records; older records are dropped. */
export const MAX_RECORDS = 500;

/** A saved in-flight session older than this is discarded rather than resumed. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SETTINGS_KEY = 'settings';
export const RECORDS_KEY = 'records';

/** The subset of `chrome.storage.StorageArea` this project relies on. */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultMode: 'countup',
  countdownLimitSeconds: 60,
  soundEnabled: true,
  overlayVisible: true,
  overlayCollapsed: false,
  overlayPosition: { anchor: 'top-right', x: 16, y: 96 },
  resumeAcrossReload: true,
  detectionDebounceMs: 400,
  detectionCooldownMs: 1200,
};

/** Storage key for the in-flight session of one exercise/quiz. */
export function sessionKey(exerciseKey: string): string {
  return `session:${exerciseKey}`;
}

/**
 * Wrap `chrome.storage.local` when it is available. Returns null in contexts
 * where the extension API is missing (e.g. a plain page load in tests), which
 * callers treat as "persistence disabled" and report in diagnostics.
 */
export function chromeStorageArea(): StorageArea | null {
  const api = typeof chrome !== 'undefined' ? chrome : undefined;
  const area = api?.storage?.local;
  if (!area) return null;
  return {
    async get(keys) {
      return (await area.get(keys ?? null)) as Record<string, unknown>;
    },
    async set(items) {
      await area.set(items);
    },
    async remove(keys) {
      await area.remove(keys);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** Coerce whatever storage holds into a valid `Settings` object. */
export function sanitizeSettings(raw: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const mode = source['defaultMode'];
  const anchor = source['overlayPosition'];

  return {
    defaultMode: mode === 'countdown' ? 'countdown' : 'countup',
    countdownLimitSeconds: Math.round(
      clampNumber(source['countdownLimitSeconds'], 5, 3600, DEFAULT_SETTINGS.countdownLimitSeconds),
    ),
    soundEnabled: toBoolean(source['soundEnabled'], DEFAULT_SETTINGS.soundEnabled),
    overlayVisible: toBoolean(source['overlayVisible'], DEFAULT_SETTINGS.overlayVisible),
    overlayCollapsed: toBoolean(source['overlayCollapsed'], DEFAULT_SETTINGS.overlayCollapsed),
    overlayPosition: sanitizePosition(anchor),
    resumeAcrossReload: toBoolean(source['resumeAcrossReload'], DEFAULT_SETTINGS.resumeAcrossReload),
    detectionDebounceMs: Math.round(
      clampNumber(source['detectionDebounceMs'], 100, 5000, DEFAULT_SETTINGS.detectionDebounceMs),
    ),
    detectionCooldownMs: Math.round(
      clampNumber(source['detectionCooldownMs'], 0, 10000, DEFAULT_SETTINGS.detectionCooldownMs),
    ),
  };
}

function sanitizePosition(raw: unknown): Settings['overlayPosition'] {
  const fallback = DEFAULT_SETTINGS.overlayPosition;
  if (!isRecord(raw)) return { ...fallback };
  const anchors = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'custom'] as const;
  const anchor = anchors.find((a) => a === raw['anchor']) ?? fallback.anchor;
  return {
    anchor,
    x: Math.round(clampNumber(raw['x'], -4000, 8000, fallback.x)),
    y: Math.round(clampNumber(raw['y'], -4000, 8000, fallback.y)),
  };
}

export async function loadSettings(area: StorageArea | null): Promise<Settings> {
  if (!area) return { ...DEFAULT_SETTINGS };
  try {
    const got = await area.get(SETTINGS_KEY);
    return sanitizeSettings(got[SETTINGS_KEY]);
  } catch {
    // Storage unreadable: run on defaults rather than failing to start.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(area: StorageArea | null, settings: Settings): Promise<boolean> {
  if (!area) return false;
  try {
    await area.set({ [SETTINGS_KEY]: sanitizeSettings(settings) });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/** Coerce stored data into a well-formed record list. */
export function sanitizeRecords(raw: unknown): QuestionRecord[] {
  const container = isRecord(raw) ? raw : {};
  const items = Array.isArray(container['records']) ? container['records'] : [];
  const out: QuestionRecord[] = [];
  for (const candidate of items) {
    if (!isRecord(candidate)) continue;
    const questionKey = typeof candidate['questionKey'] === 'string' ? candidate['questionKey'] : '';
    const startedAt = Number(candidate['startedAt']);
    if (!questionKey || !Number.isFinite(startedAt)) continue;
    out.push({
      id: typeof candidate['id'] === 'string' && candidate['id'] ? candidate['id'] : `r_${startedAt}`,
      questionKey,
      exerciseKey: typeof candidate['exerciseKey'] === 'string' ? candidate['exerciseKey'] : '',
      startedAt,
      endedAt: Number(candidate['endedAt']) || startedAt,
      durationMs: Math.max(0, Number(candidate['durationMs']) || 0),
      pausedMs: Math.max(0, Number(candidate['pausedMs']) || 0),
      mode: candidate['mode'] === 'countdown' ? 'countdown' : 'countup',
      limitMs: typeof candidate['limitMs'] === 'number' ? candidate['limitMs'] : null,
      timedOut: toBoolean(candidate['timedOut'], false),
      firstSubmissionAt:
        typeof candidate['firstSubmissionAt'] === 'number' ? candidate['firstSubmissionAt'] : null,
      firstSubmissionOutcome:
        candidate['firstSubmissionOutcome'] === 'correct' ||
        candidate['firstSubmissionOutcome'] === 'incorrect'
          ? candidate['firstSubmissionOutcome']
          : candidate['firstSubmissionOutcome'] === 'unknown'
            ? 'unknown'
            : null,
      endReason: (candidate['endReason'] as QuestionRecord['endReason']) ?? 'question-change',
      status:
        candidate['status'] === 'expired' || candidate['status'] === 'partial'
          ? candidate['status']
          : 'completed',
      detectionConfidence:
        candidate['detectionConfidence'] === 'stable-id' ||
        candidate['detectionConfidence'] === 'fingerprint' ||
        candidate['detectionConfidence'] === 'weak'
          ? candidate['detectionConfidence']
          : 'none',
      wasPaused: toBoolean(candidate['wasPaused'], false),
    });
  }
  return out;
}

export async function loadRecords(area: StorageArea | null): Promise<QuestionRecord[]> {
  if (!area) return [];
  try {
    const got = await area.get(RECORDS_KEY);
    return sanitizeRecords(got[RECORDS_KEY]);
  } catch {
    return [];
  }
}

/**
 * Append one record, keeping only the newest `MAX_RECORDS`.
 * Returns the resulting list, or null when the write failed.
 */
export async function addRecord(
  area: StorageArea | null,
  record: QuestionRecord,
): Promise<QuestionRecord[] | null> {
  if (!area) return null;
  try {
    const existing = await loadRecords(area);
    const next = [...existing, record].slice(-MAX_RECORDS);
    await area.set({ [RECORDS_KEY]: { version: 1, records: next } satisfies StoredRecords });
    return next;
  } catch {
    return null;
  }
}

/** Remove all saved timing records (spec 8.4). Settings are untouched. */
export async function clearRecords(area: StorageArea | null): Promise<boolean> {
  if (!area) return false;
  try {
    await area.remove(RECORDS_KEY);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * In-flight sessions (survive closing the page)
 * ------------------------------------------------------------------ */

export function sanitizeSession(raw: unknown): TimerSerialized | null {
  if (!isRecord(raw)) return null;
  const savedAt = Number(raw['savedAt']);
  const accumulatedMs = Number(raw['accumulatedMs']);
  const questionKey = raw['questionKey'];
  if (typeof questionKey !== 'string' || !questionKey) return null;
  if (!Number.isFinite(savedAt) || !Number.isFinite(accumulatedMs)) return null;
  const phase = raw['phase'];
  return {
    version: 1,
    mode: raw['mode'] === 'countdown' ? 'countdown' : 'countup',
    phase: phase === 'paused' || phase === 'finished' ? phase : 'running',
    questionKey,
    exerciseKey: typeof raw['exerciseKey'] === 'string' ? raw['exerciseKey'] : '',
    startedAt: Number(raw['startedAt']) || savedAt,
    accumulatedMs: Math.max(0, accumulatedMs),
    pausedMs: Math.max(0, Number(raw['pausedMs']) || 0),
    limitMs: typeof raw['limitMs'] === 'number' ? raw['limitMs'] : null,
    expiredAt: typeof raw['expiredAt'] === 'number' ? raw['expiredAt'] : null,
    firstSubmissionAt:
      typeof raw['firstSubmissionAt'] === 'number' ? raw['firstSubmissionAt'] : null,
    firstSubmissionOutcome:
      raw['firstSubmissionOutcome'] === 'correct' ||
      raw['firstSubmissionOutcome'] === 'incorrect' ||
      raw['firstSubmissionOutcome'] === 'unknown'
        ? raw['firstSubmissionOutcome']
        : null,
    savedAt,
  };
}

export async function saveSession(
  area: StorageArea | null,
  session: TimerSerialized,
): Promise<boolean> {
  if (!area) return false;
  try {
    await area.set({ [sessionKey(session.exerciseKey)]: session });
    return true;
  } catch {
    return false;
  }
}

/** Load a session for `exerciseKey`, discarding it when stale or malformed. */
export async function loadSession(
  area: StorageArea | null,
  exerciseKey: string,
  now: number,
  ttlMs = SESSION_TTL_MS,
): Promise<TimerSerialized | null> {
  if (!area) return null;
  try {
    const key = sessionKey(exerciseKey);
    const got = await area.get(key);
    const session = sanitizeSession(got[key]);
    if (!session) return null;
    if (now - session.savedAt > ttlMs) {
      await area.remove(key).catch(() => undefined);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export async function clearSession(
  area: StorageArea | null,
  exerciseKey: string,
): Promise<boolean> {
  if (!area) return false;
  try {
    await area.remove(sessionKey(exerciseKey));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort removal of every stale `session:` entry. */
export async function pruneSessions(
  area: StorageArea | null,
  now: number,
  ttlMs = SESSION_TTL_MS,
): Promise<number> {
  if (!area) return 0;
  try {
    const all = await area.get(null);
    const stale: string[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('session:')) continue;
      const session = sanitizeSession(value);
      if (!session || now - session.savedAt > ttlMs) stale.push(key);
    }
    if (stale.length > 0) await area.remove(stale);
    return stale.length;
  } catch {
    return 0;
  }
}

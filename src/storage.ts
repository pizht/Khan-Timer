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
  ActiveRun,
  LanguageSetting,
  QuestionRecord,
  Settings,
  StoredRecords,
  TimerSerialized,
} from './types.js';
import { isLocale } from './i18n/index.js';
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
  language: 'auto',
  defaultMode: 'countup',
  countdownLimitSeconds: 60,
  soundEnabled: true,
  overlayVisible: true,
  overlayCollapsed: false,
  developerMode: false,
  summaryCollapsed: false,
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
    language: sanitizeLanguage(source['language']),
    defaultMode: mode === 'countdown' ? 'countdown' : 'countup',
    countdownLimitSeconds: Math.round(
      clampNumber(source['countdownLimitSeconds'], 5, 3600, DEFAULT_SETTINGS.countdownLimitSeconds),
    ),
    soundEnabled: toBoolean(source['soundEnabled'], DEFAULT_SETTINGS.soundEnabled),
    overlayVisible: toBoolean(source['overlayVisible'], DEFAULT_SETTINGS.overlayVisible),
    overlayCollapsed: toBoolean(source['overlayCollapsed'], DEFAULT_SETTINGS.overlayCollapsed),
    developerMode: toBoolean(source['developerMode'], DEFAULT_SETTINGS.developerMode),
    summaryCollapsed: toBoolean(source['summaryCollapsed'], DEFAULT_SETTINGS.summaryCollapsed),
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

/**
 * Coerce the stored language into a valid setting.
 *
 * Anything unrecognised — including a `Settings` object written by a version
 * that predates the language setting, where the key is simply absent — becomes
 * `auto`, so no migration pass is needed and an old profile keeps working.
 */
function sanitizeLanguage(raw: unknown): LanguageSetting {
  return isLocale(raw) ? raw : 'auto';
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
        candidate['status'] === 'expired' ||
        candidate['status'] === 'partial' ||
        candidate['status'] === 'skipped'
          ? candidate['status']
          : 'completed',
      detectionConfidence:
        candidate['detectionConfidence'] === 'stable-id' ||
        candidate['detectionConfidence'] === 'fingerprint' ||
        candidate['detectionConfidence'] === 'weak'
          ? candidate['detectionConfidence']
          : 'none',
      wasPaused: toBoolean(candidate['wasPaused'], false),
      // Records written before the run model existed simply have no run id;
      // they are still readable, they just will not appear in a summary.
      runId: typeof candidate['runId'] === 'string' ? candidate['runId'] : '',
      questionIndex:
        typeof candidate['questionIndex'] === 'number' ? candidate['questionIndex'] : null,
      questionTotal:
        typeof candidate['questionTotal'] === 'number' ? candidate['questionTotal'] : null,
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

/** Serialised writer for the shared `records` list. */
export interface RecordQueue {
  /** Append one record; resolves with the resulting list, or null on failure. */
  add(record: QuestionRecord): Promise<QuestionRecord[] | null>;
  /** Resolve once every queued write has landed. */
  flush(): Promise<void>;
}

/**
 * Create the single serialised writer for the `records` list.
 *
 * `addRecord` is a read-modify-write (`loadRecords` -> append -> `set`) and
 * `chrome.storage` offers no transaction: two overlapping calls both read the
 * old list and the second `set` then drops the first record. That is exactly how
 * a per-question row can disappear from the end-of-exercise card, and the writes
 * that overlap in practice are the ones fired without being awaited - e.g.
 * flushing the held record of a question when the learner leaves a practice for
 * another one. One queue for every writer makes a torn write impossible.
 *
 * `flush()` exists so a reader (the end-of-exercise card) can be certain the
 * records it is about to load include every write that has already been asked
 * for.
 */
export function createRecordQueue(area: StorageArea | null): RecordQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    add(record) {
      const write = tail.then(() => addRecord(area, record));
      // Keep the chain usable even when a write fails (storage unreadable).
      tail = write.catch(() => undefined);
      return write;
    },
    async flush() {
      await tail;
    },
  };
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
 * Exercise runs (one pass through an exercise)
 * ------------------------------------------------------------------ */

/** A run older than this is treated as abandoned and replaced. */
export const RUN_TTL_MS = 6 * 60 * 60 * 1000;

export function runKey(exerciseKey: string): string {
  return `run:${exerciseKey}`;
}

export function sanitizeRun(raw: unknown): ActiveRun | null {
  if (!isRecord(raw)) return null;
  const runId = raw['runId'];
  const startedAt = Number(raw['startedAt']);
  if (typeof runId !== 'string' || !runId) return null;
  if (!Number.isFinite(startedAt)) return null;
  return {
    version: 1,
    runId,
    exerciseKey: typeof raw['exerciseKey'] === 'string' ? raw['exerciseKey'] : '',
    startedAt,
    summarizedAt: typeof raw['summarizedAt'] === 'number' ? raw['summarizedAt'] : null,
    lastQuestionIndex:
      typeof raw['lastQuestionIndex'] === 'number' ? raw['lastQuestionIndex'] : null,
  };
}

/**
 * Fetch the run in progress for an exercise, or null when a new one should
 * start. A run is finished once its summary has been shown, or when it is so
 * old that it cannot belong to the attempt the learner is making now.
 */
export async function loadRun(
  area: StorageArea | null,
  exerciseKey: string,
  now: number,
  ttlMs = RUN_TTL_MS,
): Promise<ActiveRun | null> {
  if (!area) return null;
  try {
    const key = runKey(exerciseKey);
    const got = await area.get(key);
    const run = sanitizeRun(got[key]);
    if (!run) return null;
    if (run.summarizedAt !== null) return null;
    if (now - run.startedAt > ttlMs) return null;
    return run;
  } catch {
    return null;
  }
}

export async function saveRun(area: StorageArea | null, run: ActiveRun): Promise<boolean> {
  if (!area) return false;
  try {
    await area.set({ [runKey(run.exerciseKey)]: run });
    return true;
  } catch {
    return false;
  }
}

/** Forget the run so the next question starts a fresh one. */
export async function clearRun(area: StorageArea | null, exerciseKey: string): Promise<boolean> {
  if (!area) return false;
  try {
    await area.remove(runKey(exerciseKey));
    return true;
  } catch {
    return false;
  }
}

/** Records belonging to one run, in the order they were captured. */
export function recordsForRun(records: QuestionRecord[], runId: string): QuestionRecord[] {
  if (!runId) return [];
  return records.filter((record) => record.runId === runId);
}

/**
 * The attempt WINDOW of one practice: "what the learner has done on this
 * practice since this attempt began".
 *
 * It exists because the run id can be lost in the middle of an attempt (measured
 * on khanacademy.org: moving to another practice inside the app ended the attempt
 * there, so the questions timed before the switch were filed under an older run
 * id and the card showed them as 数据缺失 even though their records were still
 * stored). The window is a second, independent way to find them again, keyed by
 * the practice route and a timestamp instead of by the attempt id.
 */
export interface AttemptWindow {
  version: 1;
  /** Wall clock the current attempt's window opens at. */
  since: number;
  /** When this practice's summary was last shown, if it ever was. */
  lastSummarizedAt: number | null;
}

export function attemptKey(exerciseKey: string): string {
  return `attempt:${exerciseKey}`;
}

export function sanitizeAttemptWindow(raw: unknown): AttemptWindow | null {
  if (!isRecord(raw)) return null;
  const since = Number(raw['since']);
  if (!Number.isFinite(since)) return null;
  const lastSummarizedAt = Number(raw['lastSummarizedAt']);
  return {
    version: 1,
    since,
    lastSummarizedAt: Number.isFinite(lastSummarizedAt) ? lastSummarizedAt : null,
  };
}

/** The attempt window of one practice, or null when the learner never started it. */
export async function loadAttemptWindow(
  area: StorageArea | null,
  exerciseKey: string,
): Promise<AttemptWindow | null> {
  if (!area) return null;
  try {
    const key = attemptKey(exerciseKey);
    const got = await area.get(key);
    return sanitizeAttemptWindow(got[key]);
  } catch {
    return null;
  }
}

/**
 * Open (or keep) the attempt window of a practice and return its start.
 *
 * A question starting on a practice opens the window the first time it is seen.
 * It is only moved forward when the practice's summary has been shown since the
 * window opened - i.e. when the learner has genuinely started a new attempt.
 * An attempt id lost in between therefore does NOT start a new window, which is
 * what keeps the earlier questions of the same attempt retrievable.
 */
export async function ensureAttemptWindow(
  area: StorageArea | null,
  exerciseKey: string,
  now: number,
): Promise<number> {
  const existing = await loadAttemptWindow(area, exerciseKey);
  const startsNewAttempt =
    !existing ||
    (existing.lastSummarizedAt !== null && existing.lastSummarizedAt >= existing.since);
  if (!startsNewAttempt && existing) return existing.since;
  const next: AttemptWindow = {
    version: 1,
    since: now,
    lastSummarizedAt: existing?.lastSummarizedAt ?? null,
  };
  if (area) {
    try {
      await area.set({ [attemptKey(exerciseKey)]: next });
    } catch {
      /* storage unreadable: the card falls back to the run id */
    }
  }
  return next.since;
}

/** Remember that this practice's summary has just been shown. */
export async function markAttemptSummarized(
  area: StorageArea | null,
  exerciseKey: string,
  at: number,
): Promise<boolean> {
  if (!area) return false;
  try {
    const existing = await loadAttemptWindow(area, exerciseKey);
    const next: AttemptWindow = {
      version: 1,
      since: existing?.since ?? at,
      lastSummarizedAt: at,
    };
    await area.set({ [attemptKey(exerciseKey)]: next });
    return true;
  } catch {
    return false;
  }
}

/**
 * The records that belong on the end-of-exercise card of one practice.
 *
 * Selection goes through the PRACTICE first - the route the question was timed
 * on (`exerciseKey`, i.e. which exercise) - and only then narrows to the attempt
 * being finished (`runId`): a record from another practice can never appear on
 * this card even if run ids were to collide or be lost.
 *
 * The run id is the attempt discriminator, with the newest attempt recorded for
 * this practice used as a fallback when the current run has no records at all
 * (the learner left for another practice, the page reloaded, or the run identity
 * was otherwise lost). Without that fallback the card would come up empty for a
 * practice whose questions were timed before the interruption - which is exactly
 * the data the learner expects to see.
 */
export function attemptRecordsFor(
  records: QuestionRecord[],
  exerciseKey: string,
  runId: string,
  since: number | null = null,
): QuestionRecord[] {
  const forExercise = records.filter((record) => record.exerciseKey === exerciseKey);

  // The attempt WINDOW: everything this learner did on this practice since its
  // summary was last shown, whatever run id it was written under. This is what
  // brings back the questions timed before the learner left for another practice
  // when the attempt id changed in between - the records were never lost, only
  // filed under the previous attempt.
  if (since !== null) {
    const window = forExercise.filter((record) => record.startedAt >= since);
    if (window.length > 0) return window;
  }

  const exact = forExercise.filter((record) => record.runId === runId);
  if (exact.length > 0) return exact;
  // Newest last: the last captured run id is the attempt the learner is on.
  const newestRunId = forExercise[forExercise.length - 1]?.runId ?? '';
  if (!newestRunId) return [];
  return forExercise.filter((record) => record.runId === newestRunId);
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
    stemFingerprint: typeof raw['stemFingerprint'] === 'string' ? raw['stemFingerprint'] : null,
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

/**
 * Re-freeze an in-flight session because the learner left the exercise without
 * finishing the question they were on.
 *
 * The clock stops at `elapsedMs` - the time actually spent answering - but the
 * session is written back as `running`, so returning to the exercise continues
 * from that value instead of counting the time spent in the other exercise.
 * This is the same rule as closing and reopening the page (spec 2.2): time
 * while the learner is somewhere else is not answer time.
 */
export function parkedSession(
  session: TimerSerialized,
  elapsedMs: number,
  now: number,
): TimerSerialized {
  return {
    ...session,
    phase: 'running',
    accumulatedMs: Math.max(0, elapsedMs),
    savedAt: now,
  };
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

/**
 * Storage tests (spec 2.5, 8.4, 9.11).
 *
 * Covers settings persistence, record retention and clearing, the resumable
 * session, and the degraded behaviour required by spec 5.3 when local storage
 * is empty, unreadable or write-failing — including the case where the stored
 * data has been corrupted by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_RECORDS,
  SESSION_TTL_MS,
  addRecord,
  attemptKey,
  attemptRecordsFor,
  ensureAttemptWindow,
  loadAttemptWindow,
  markAttemptSummarized,
  chromeStorageArea,
  clearRecords,
  clearSession,
  createRecordQueue,
  loadRecords,
  loadSession,
  loadSettings,
  parkedSession,
  pruneSessions,
  sanitizeRecords,
  sanitizeSession,
  sanitizeSettings,
  saveSession,
  saveSettings,
  sessionKey,
} from '../src/storage.js';
import { TimerEngine } from '../src/timer-engine.js';
import type { QuestionRecord, TimerSerialized } from '../src/types.js';

/** In-memory stand-in for `chrome.storage.local`. */
class FakeArea {
  data: Record<string, unknown> = {};
  failOnSet = false;
  failOnGet = false;
  failOnRemove = false;

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (this.failOnGet) throw new Error('storage read failed');
    if (keys === null) return { ...this.data };
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in this.data) out[key] = this.data[key];
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failOnSet) throw new Error('storage write failed');
    Object.assign(this.data, items);
  }

  async remove(keys: string | string[]): Promise<void> {
    if (this.failOnRemove) throw new Error('storage remove failed');
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }
}

function makeRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: 'rec_1',
    questionKey: 'id:progress:1 of 4',
    exerciseKey: '/math/x/e/addition_4',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_030_000,
    durationMs: 30_000,
    pausedMs: 0,
    mode: 'countup',
    limitMs: null,
    timedOut: false,
    firstSubmissionAt: 1_700_000_020_000,
    firstSubmissionOutcome: 'incorrect',
    endReason: 'question-change',
    status: 'completed',
    detectionConfidence: 'stable-id',
    wasPaused: false,
    runId: 'run_test',
    questionIndex: 0,
    questionTotal: 4,
    ...overrides,
  };
}

function makeSession(overrides: Partial<TimerSerialized> = {}): TimerSerialized {
  return {
    version: 1,
    mode: 'countup',
    phase: 'running',
    questionKey: 'id:progress:1 of 4',
    stemFingerprint: null,
    exerciseKey: '/math/x/e/addition_4',
    startedAt: 1_700_000_000_000,
    accumulatedMs: 12_000,
    pausedMs: 0,
    limitMs: null,
    expiredAt: null,
    firstSubmissionAt: null,
    firstSubmissionOutcome: null,
    savedAt: 1_700_000_012_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeSettings', () => {
  it('returns the defaults for junk input', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps an out-of-range limit instead of trusting it', () => {
    expect(sanitizeSettings({ countdownLimitSeconds: -5 }).countdownLimitSeconds).toBe(5);
    expect(sanitizeSettings({ countdownLimitSeconds: 99_999 }).countdownLimitSeconds).toBe(3600);
    expect(sanitizeSettings({ countdownLimitSeconds: 'abc' }).countdownLimitSeconds).toBe(60);
  });

  it('falls back on an unknown timer mode', () => {
    expect(sanitizeSettings({ defaultMode: 'sideways' }).defaultMode).toBe('countup');
    expect(sanitizeSettings({ defaultMode: 'countdown' }).defaultMode).toBe('countdown');
  });

  it('validates the overlay anchor and offsets', () => {
    const position = sanitizeSettings({ overlayPosition: { anchor: 'nowhere', x: 1e9, y: 'x' } })
      .overlayPosition;
    expect(position.anchor).toBe(DEFAULT_SETTINGS.overlayPosition.anchor);
    expect(position.x).toBe(8000);
    expect(position.y).toBe(DEFAULT_SETTINGS.overlayPosition.y);
  });

  it('defaults the summary-card collapse state to expanded', () => {
    expect(sanitizeSettings({}).summaryCollapsed).toBe(false);
    expect(sanitizeSettings({ summaryCollapsed: true }).summaryCollapsed).toBe(true);
    // Tolerates the stringy form storage may hold, and junk falls back.
    expect(sanitizeSettings({ summaryCollapsed: 'true' }).summaryCollapsed).toBe(true);
    expect(sanitizeSettings({ summaryCollapsed: 'nonsense' }).summaryCollapsed).toBe(false);
  });

  it('round-trips the summary-card collapse state', async () => {
    const area = new FakeArea();
    await saveSettings(area, { ...DEFAULT_SETTINGS, summaryCollapsed: true });
    expect((await loadSettings(area)).summaryCollapsed).toBe(true);
  });

  it('accepts string booleans that storage may hold', () => {
    expect(sanitizeSettings({ soundEnabled: 'false' }).soundEnabled).toBe(false);
    expect(sanitizeSettings({ soundEnabled: 'true' }).soundEnabled).toBe(true);
  });

  it('keeps developer mode off unless it was explicitly enabled', () => {
    // The popup hides the detection internals when this is false, so a junk or
    // missing value must never switch them on.
    expect(sanitizeSettings({}).developerMode).toBe(false);
    expect(sanitizeSettings({ developerMode: 'nonsense' }).developerMode).toBe(false);
    expect(sanitizeSettings({ developerMode: true }).developerMode).toBe(true);
    expect(sanitizeSettings({ developerMode: 'true' }).developerMode).toBe(true);
  });

  it('round-trips developer mode through storage', async () => {
    const area = new FakeArea();
    await saveSettings(area, { ...DEFAULT_SETTINGS, developerMode: true });
    expect((await loadSettings(area)).developerMode).toBe(true);
  });
});

describe('settings persistence', () => {
  it('round-trips through storage', async () => {
    const area = new FakeArea();
    const saved = await saveSettings(area, { ...DEFAULT_SETTINGS, defaultMode: 'countdown', countdownLimitSeconds: 90 });
    expect(saved).toBe(true);
    const loaded = await loadSettings(area);
    expect(loaded.defaultMode).toBe('countdown');
    expect(loaded.countdownLimitSeconds).toBe(90);
  });

  it('survives a page reload by reading back from storage', async () => {
    const area = new FakeArea();
    await saveSettings(area, { ...DEFAULT_SETTINGS, soundEnabled: false, overlayCollapsed: true });
    // A new "page load" reads the same area.
    const reloaded = await loadSettings(area);
    expect(reloaded.soundEnabled).toBe(false);
    expect(reloaded.overlayCollapsed).toBe(true);
  });

  it('degrades to defaults when storage is unreadable', async () => {
    const area = new FakeArea();
    area.failOnGet = true;
    expect(await loadSettings(area)).toEqual(DEFAULT_SETTINGS);
  });

  it('reports failure instead of throwing when a write fails', async () => {
    const area = new FakeArea();
    area.failOnSet = true;
    await expect(saveSettings(area, DEFAULT_SETTINGS)).resolves.toBe(false);
  });

  it('works without a storage area at all', async () => {
    expect(await loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(await saveSettings(null, DEFAULT_SETTINGS)).toBe(false);
    expect(await loadRecords(null)).toEqual([]);
    expect(await addRecord(null, makeRecord())).toBeNull();
    expect(await clearRecords(null)).toBe(false);
    expect(await loadSession(null, 'x', Date.now())).toBeNull();
  });
});

describe('records', () => {
  it('starts empty', async () => {
    expect(await loadRecords(new FakeArea())).toEqual([]);
  });

  it('appends and reads back', async () => {
    const area = new FakeArea();
    const saved = await addRecord(area, makeRecord({ id: 'a' }));
    expect(saved).toHaveLength(1);
    const records = await loadRecords(area);
    expect(records[0]?.id).toBe('a');
    expect(records[0]?.durationMs).toBe(30_000);
    expect(records[0]?.firstSubmissionOutcome).toBe('incorrect');
  });

  it('caps retained records and drops the oldest', async () => {
    const area = new FakeArea();
    for (let i = 0; i < MAX_RECORDS + 25; i += 1) {
      await addRecord(area, makeRecord({ id: `r${i}`, startedAt: 1_700_000_000_000 + i }));
    }
    const records = await loadRecords(area);
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[0]?.id).toBe('r25');
    expect(records[records.length - 1]?.id).toBe(`r${MAX_RECORDS + 24}`);
  });

  it('reports failure instead of throwing when a write fails', async () => {
    const area = new FakeArea();
    area.failOnSet = true;
    await expect(addRecord(area, makeRecord())).resolves.toBeNull();
  });

  it('clears records but leaves settings alone (spec 8.4)', async () => {
    const area = new FakeArea();
    await saveSettings(area, { ...DEFAULT_SETTINGS, countdownLimitSeconds: 120 });
    await addRecord(area, makeRecord());
    expect(await clearRecords(area)).toBe(true);
    expect(await loadRecords(area)).toEqual([]);
    expect((await loadSettings(area)).countdownLimitSeconds).toBe(120);
  });

  it('reports a failed clear rather than pretending it worked', async () => {
    const area = new FakeArea();
    await addRecord(area, makeRecord());
    area.failOnRemove = true;
    expect(await clearRecords(area)).toBe(false);
    expect(await loadRecords(area)).toHaveLength(1);
  });

  it('drops corrupted entries instead of rendering nonsense', () => {
    const records = sanitizeRecords({
      version: 1,
      records: [
        makeRecord({ id: 'good' }),
        null,
        'nope',
        { id: 'no-question-key', startedAt: 1 },
        { id: 'no-started-at', questionKey: 'x' },
        { questionKey: 'ok', startedAt: 5, durationMs: -100, mode: 'weird' },
      ],
    });
    expect(records.map((r) => r.id)).toEqual(['good', 'r_5']);
    expect(records[1]?.durationMs).toBe(0);
    expect(records[1]?.mode).toBe('countup');
    expect(records[1]?.status).toBe('completed');
    expect(records[1]?.detectionConfidence).toBe('none');
  });

  it('treats a missing records key as empty', () => {
    expect(sanitizeRecords(undefined)).toEqual([]);
    expect(sanitizeRecords({ version: 1 })).toEqual([]);
  });
});

/**
 * `addRecord` is a read-modify-write and `chrome.storage` has no transaction:
 * two overlapping calls both read the old list and the second `set` then drops
 * the first record. That is how a question can vanish from the end-of-exercise
 * card, so every writer goes through `createRecordQueue`.
 */
describe('record write queue (no torn read-modify-write)', () => {
  /**
   * Storage whose round-trip takes a turn of the event loop, the way the real
   * message-passing `chrome.storage.local` does. Without that delay the hazard
   * is invisible: an in-memory fake resolves both calls before either `set`
   * runs.
   */
  class SlowArea extends FakeArea {
    override async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return super.get(keys);
    }

    override async set(items: Record<string, unknown>): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return super.set(items);
    }
  }

  it('keeps every record when writes are requested back to back', async () => {
    const area = new SlowArea();
    const queue = createRecordQueue(area);

    const ids = ['rec_a', 'rec_b', 'rec_c'];
    await Promise.all(ids.map((id) => queue.add(makeRecord({ id }))));
    await queue.flush();

    expect((await loadRecords(area)).map((record) => record.id)).toEqual(ids);
  });

  it('lets a reader wait for the writes already requested', async () => {
    const area = new SlowArea();
    const queue = createRecordQueue(area);

    // Fired without being awaited, exactly like the held record flushed when the
    // learner leaves a practice: the card must still see it.
    void queue.add(makeRecord({ id: 'rec_flushed' }));
    await queue.flush();

    expect((await loadRecords(area)).map((record) => record.id)).toEqual(['rec_flushed']);
  });

  it('keeps working after a write fails', async () => {
    const area = new SlowArea();
    const queue = createRecordQueue(area);
    area.failOnSet = true;

    await expect(queue.add(makeRecord({ id: 'rec_failed' }))).resolves.toBeNull();
    area.failOnSet = false;
    await queue.add(makeRecord({ id: 'rec_after_failure' }));
    await queue.flush();

    expect((await loadRecords(area)).map((record) => record.id)).toEqual(['rec_after_failure']);
  });
});

/**
 * The card is built from the attempt of ONE practice, found through the route
 * the questions were timed on.
 */
describe('attemptRecordsFor (route first, then attempt)', () => {
  const A = '/math/x/e/addition_4';
  const B = '/math/x/e/subtraction_4';

  it('keeps another practice out even when the run id matches', () => {
    const records = [
      makeRecord({ id: 'a1', exerciseKey: A, runId: 'run_1', questionIndex: 0 }),
      makeRecord({ id: 'b1', exerciseKey: B, runId: 'run_1', questionIndex: 0 }),
    ];
    const selected = attemptRecordsFor(records, A, 'run_1');
    expect(selected.map((record) => record.id)).toEqual(['a1']);
  });

  it('returns the questions timed before and after a switch, in capture order', () => {
    const records = [
      makeRecord({ id: 'a1', exerciseKey: A, runId: 'run_1', questionIndex: 0 }),
      makeRecord({ id: 'b1', exerciseKey: B, runId: 'run_2', questionIndex: 0 }),
      makeRecord({ id: 'a2', exerciseKey: A, runId: 'run_1', questionIndex: 1 }),
      makeRecord({ id: 'a3', exerciseKey: A, runId: 'run_1', questionIndex: 2 }),
    ];
    expect(attemptRecordsFor(records, A, 'run_1').map((record) => record.id)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
  });

  it('falls back to the newest attempt of that practice when the run identity was lost', () => {
    const records = [
      makeRecord({ id: 'a1', exerciseKey: A, runId: 'run_old', questionIndex: 0 }),
      makeRecord({ id: 'a2', exerciseKey: A, runId: 'run_old', questionIndex: 1 }),
      makeRecord({ id: 'b1', exerciseKey: B, runId: 'run_b', questionIndex: 0 }),
    ];
    // The run the extension holds now has no records of its own.
    expect(attemptRecordsFor(records, A, 'run_lost').map((record) => record.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  it('finds the questions timed before a switch even when the attempt id changed', () => {
    // The learner's attempt id was lost mid-way (measured live: leaving for
    // another practice ended the attempt), so the first questions sit under an
    // older run id. The window is what brings them back.
    const since = 1_700_000_500_000;
    const records = [
      makeRecord({ id: 'old', exerciseKey: A, runId: 'run_previous', startedAt: since - 60_000 }),
      makeRecord({ id: 'a1', exerciseKey: A, runId: 'run_before', startedAt: since + 1000, questionIndex: 0 }),
      makeRecord({ id: 'b1', exerciseKey: B, runId: 'run_b', startedAt: since + 2000, questionIndex: 0 }),
      makeRecord({ id: 'a2', exerciseKey: A, runId: 'run_after', startedAt: since + 3000, questionIndex: 1 }),
    ];
    expect(attemptRecordsFor(records, A, 'run_after', since).map((record) => record.id)).toEqual([
      'a1',
      'a2',
    ]);
    // Without a known boundary it still narrows to the current attempt.
    expect(attemptRecordsFor(records, A, 'run_after', null).map((record) => record.id)).toEqual([
      'a2',
    ]);
  });

  it('opens one window per attempt and only moves it after a summary', async () => {
    const area = new FakeArea();
    expect(await loadAttemptWindow(area, A)).toBeNull();

    // First question of the attempt opens the window ...
    expect(await ensureAttemptWindow(area, A, 1000)).toBe(1000);
    // ... and a later question, even under a new attempt id, keeps it.
    expect(await ensureAttemptWindow(area, A, 5000)).toBe(1000);
    expect(await loadAttemptWindow(area, B)).toBeNull();

    // Showing the summary closes the attempt: the next question opens a new one.
    expect(await markAttemptSummarized(area, A, 9000)).toBe(true);
    expect(await ensureAttemptWindow(area, A, 12_000)).toBe(12_000);
    expect(area.data[attemptKey(A)]).toEqual({
      version: 1,
      since: 12_000,
      lastSummarizedAt: 9000,
    });
  });

  it('returns nothing for a practice with no records at all', () => {
    expect(attemptRecordsFor([makeRecord({ exerciseKey: B, runId: 'run_b' })], A, 'run_x')).toEqual(
      [],
    );
  });
});

describe('in-flight sessions (spec 2.2 — closing the page keeps the data)', () => {
  /** Fixed "now" so session TTL behaviour is deterministic. */
  const NOW = 1_700_000_100_000;

  it('namespaces the key by exercise', () => {
    expect(sessionKey('/math/x/e/addition_4')).toBe('session:/math/x/e/addition_4');
  });

  it('round-trips a running session', async () => {
    const area = new FakeArea();
    const session = makeSession({ savedAt: NOW - 1_000 });
    expect(await saveSession(area, session)).toBe(true);
    const loaded = await loadSession(area, session.exerciseKey, NOW);
    expect(loaded).toMatchObject({ accumulatedMs: 12_000, questionKey: 'id:progress:1 of 4' });
  });

  it('keeps sessions of different exercises apart', async () => {
    const area = new FakeArea();
    await saveSession(area, makeSession({ exerciseKey: '/math/x/e/a', accumulatedMs: 1000, savedAt: NOW }));
    await saveSession(area, makeSession({ exerciseKey: '/math/x/e/b', accumulatedMs: 2000, savedAt: NOW }));
    expect((await loadSession(area, '/math/x/e/a', NOW))?.accumulatedMs).toBe(1000);
    expect((await loadSession(area, '/math/x/e/b', NOW))?.accumulatedMs).toBe(2000);
  });

  it('discards a stale session and deletes it', async () => {
    const area = new FakeArea();
    const session = makeSession({ savedAt: NOW });
    await saveSession(area, session);
    const loaded = await loadSession(area, session.exerciseKey, NOW + SESSION_TTL_MS + 1);
    expect(loaded).toBeNull();
    expect(area.data[sessionKey(session.exerciseKey)]).toBeUndefined();
  });

  it('returns null for malformed session data', () => {
    expect(sanitizeSession(null)).toBeNull();
    expect(sanitizeSession({})).toBeNull();
    expect(sanitizeSession({ questionKey: 'x' })).toBeNull();
    expect(sanitizeSession({ questionKey: 'x', savedAt: 'nope', accumulatedMs: 0 })).toBeNull();
  });

  it('normalises a partially corrupt session rather than losing the user\'s time', () => {
    const session = sanitizeSession({
      questionKey: 'q',
      savedAt: 1000,
      accumulatedMs: -50,
      phase: 'bogus',
      mode: 'bogus',
    });
    expect(session).toMatchObject({ accumulatedMs: 0, phase: 'running', mode: 'countup', limitMs: null });
  });

  it('clears one exercise session without touching the others', async () => {
    const area = new FakeArea();
    await saveSession(area, makeSession({ exerciseKey: '/a', savedAt: NOW }));
    await saveSession(area, makeSession({ exerciseKey: '/b', savedAt: NOW }));
    expect(await clearSession(area, '/a')).toBe(true);
    expect(await loadSession(area, '/a', NOW)).toBeNull();
    expect(await loadSession(area, '/b', NOW)).not.toBeNull();
  });

  it('prunes stale sessions but keeps fresh ones', async () => {
    const area = new FakeArea();
    await saveSession(area, makeSession({ exerciseKey: '/fresh', savedAt: NOW - 1000 }));
    await saveSession(area, makeSession({ exerciseKey: '/stale', savedAt: NOW - SESSION_TTL_MS - 1 }));
    area.data['settings'] = DEFAULT_SETTINGS; // unrelated key must be ignored
    area.data['session:/junk'] = 'not a session';

    const removed = await pruneSessions(area, NOW);
    // The stale session and the unparseable one are removed; `settings` is not
    // a session key and must be left completely alone.
    expect(removed).toBe(2);
    expect(area.data['session:/fresh']).toBeDefined();
    expect(area.data['settings']).toBeDefined();
    expect(area.data['session:/stale']).toBeUndefined();
    expect(area.data['session:/junk']).toBeUndefined();
  });

  it('reports a storage failure instead of throwing', async () => {
    const area = new FakeArea();
    area.failOnSet = true;
    await expect(saveSession(area, makeSession())).resolves.toBe(false);
  });

  it('keeps the time a learner had spent when they left for another exercise', () => {
    // 30s spent on question 4 of exercise A, then the learner switched to
    // exercise B for 10 minutes and came back.
    const engine = new TimerEngine({
      mode: 'countup',
      limitMs: null,
      questionKey: 'id:progress:4 of 7',
      exerciseKey: '/math/x/e/a',
      now: NOW,
    });
    const leftAt = NOW + 30_000;
    const frozen = engine.finish(leftAt, 'navigation');
    const parked = parkedSession(engine.serialize(leftAt), frozen.elapsedMs, leftAt);
    const backAt = leftAt + 10 * 60_000;
    const restored = TimerEngine.restore(parked, backAt);

    // The 10 minutes in the other exercise are not this question's time ...
    expect(restored.snapshot(backAt).elapsedMs).toBe(30_000);
    // ... and the clock carries on from there once the learner is back.
    expect(restored.snapshot(backAt + 5_000).elapsedMs).toBe(35_000);
    expect(restored.getPhase()).toBe('running');
  });

  it('parks a session that was paused, keeping pause time and resuming running', async () => {
    const area = new FakeArea();
    const parked = parkedSession(
      makeSession({ phase: 'paused', accumulatedMs: 4000, pausedMs: 2000 }),
      4_000,
      NOW,
    );
    await saveSession(area, parked);
    const loaded = await loadSession(area, parked.exerciseKey, NOW);
    expect(loaded).toMatchObject({ phase: 'running', accumulatedMs: 4_000, pausedMs: 2_000 });
  });
});

describe('chromeStorageArea', () => {
  it('returns null when the extension API is absent', () => {
    vi.stubGlobal('chrome', undefined);
    expect(chromeStorageArea()).toBeNull();
  });

  it('adapts the chrome.storage.local promise API', async () => {
    const backing: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            if (keys === null) return { ...backing };
            const list = Array.isArray(keys) ? keys : [keys];
            const out: Record<string, unknown> = {};
            for (const k of list) if (k in backing) out[k] = backing[k];
            return out;
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(backing, items);
          },
          remove: async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete backing[k];
          },
        },
      },
    });

    const area = chromeStorageArea();
    expect(area).not.toBeNull();
    await area?.set({ settings: { defaultMode: 'countdown' } });
    expect(await area?.get('settings')).toEqual({ settings: { defaultMode: 'countdown' } });
    await area?.remove('settings');
    expect(await area?.get('settings')).toEqual({});
  });
});

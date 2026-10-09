/**
 * Timer engine: the counting state machine for a single question.
 *
 * Reliability rules implemented here (spec 5.3, 8.2):
 *  - Elapsed time is always derived from timestamps, never from how many times
 *    a `setInterval` callback happened to fire. A tab that was hidden, or a
 *    machine that slept, therefore reports true elapsed wall time.
 *  - Pausing stops accumulation in both countup and countdown mode.
 *  - The countdown expiry *instant* is computed arithmetically from the running
 *    segment start, so an expiry that occurred while the page was frozen is
 *    reported at the correct wall-clock time rather than at the time of the
 *    next tick.
 *
 * The engine has no DOM and no `chrome.*` dependency, so it is fully unit
 * testable with a fake clock.
 */

import type {
  EndReason,
  FirstSubmissionOutcome,
  TimerMode,
  TimerPhase,
  TimerSerialized,
  TimerSnapshot,
} from './types.js';

/** What a `tick()` call observed. */
export interface TimerTick {
  /** True only on the first tick that observes the zero crossing (beep once). */
  expiredJustNow: boolean;
  /** The exact instant the countdown reached zero, if it has. */
  expiredAt: number | null;
  snapshot: TimerSnapshot;
}

export interface TimerEngineInit {
  mode: TimerMode;
  limitMs: number | null;
  questionKey: string;
  exerciseKey: string;
  /** Creation instant. */
  now: number;
  /** Start running immediately (default true). */
  autoStart?: boolean;
}

export class TimerEngine {
  private mode: TimerMode;
  private limitMs: number | null;
  private phase: TimerPhase = 'idle';

  questionKey: string;
  exerciseKey: string;

  /** Running time banked from completed running segments. */
  private accumulatedMs = 0;
  /** Epoch ms the current running segment began, or null when not running. */
  private segmentStart: number | null = null;
  /** Epoch ms the current pause began, or null when not paused. */
  private pauseStartedAt: number | null = null;
  /** Paused time banked from completed pauses. */
  private pausedMs = 0;

  private startedAt: number | null = null;
  private expiredAt: number | null = null;
  private expiryNotified = false;

  private firstSubmissionAt: number | null = null;
  private firstSubmissionOutcome: FirstSubmissionOutcome | null = null;
  private sawPause = false;

  constructor(init: TimerEngineInit) {
    this.mode = init.mode;
    this.limitMs = init.mode === 'countdown' ? init.limitMs : null;
    this.questionKey = init.questionKey;
    this.exerciseKey = init.exerciseKey;
    if (init.autoStart !== false) this.start(init.now);
  }

  /* ---------------- queries ---------------- */

  /** Running time excluding pauses, clamped to be non-negative. */
  elapsedMs(now: number): number {
    if (this.phase === 'running' && this.segmentStart !== null) {
      return this.accumulatedMs + Math.max(0, now - this.segmentStart);
    }
    return this.accumulatedMs;
  }

  /** Countdown remaining time, or null in countup mode. */
  remainingMs(now: number): number | null {
    if (this.limitMs === null) return null;
    return Math.max(0, this.limitMs - this.elapsedMs(now));
  }

  isExpired(): boolean {
    return this.expiredAt !== null;
  }

  getPhase(): TimerPhase {
    return this.phase;
  }

  getMode(): TimerMode {
    return this.mode;
  }

  getLimitMs(): number | null {
    return this.limitMs;
  }

  hasSeenPause(): boolean {
    return this.sawPause;
  }

  getFirstSubmission(): { at: number; outcome: FirstSubmissionOutcome } | null {
    if (this.firstSubmissionAt === null) return null;
    return { at: this.firstSubmissionAt, outcome: this.firstSubmissionOutcome ?? 'unknown' };
  }

  /** Total paused time, including a pause that is still in progress. */
  totalPausedMs(now: number): number {
    if (this.phase === 'paused' && this.pauseStartedAt !== null) {
      return this.pausedMs + Math.max(0, now - this.pauseStartedAt);
    }
    return this.pausedMs;
  }

  snapshot(now: number): TimerSnapshot {
    const elapsed = this.elapsedMs(now);
    return {
      mode: this.mode,
      phase: this.phase,
      startedAt: this.startedAt,
      elapsedMs: elapsed,
      pausedMs: this.totalPausedMs(now),
      limitMs: this.limitMs,
      remainingMs: this.limitMs === null ? null : Math.max(0, this.limitMs - elapsed),
      expired: this.expiredAt !== null,
      expiredAt: this.expiredAt,
      overrunMs:
        this.expiredAt !== null && this.limitMs !== null
          ? Math.max(0, elapsed - this.limitMs)
          : 0,
    };
  }

  /* ---------------- transitions ---------------- */

  /** Start from idle, or resume from paused. Idempotent while running. */
  start(now: number): boolean {
    if (this.phase === 'running' || this.phase === 'finished') return false;
    if (this.phase === 'paused') return this.resume(now);
    this.phase = 'running';
    this.startedAt = now;
    this.segmentStart = now;
    this.updateExpiry(now);
    return true;
  }

  pause(now: number): boolean {
    if (this.phase !== 'running') return false;
    // Resolve expiry before freezing so the crossing instant stays exact.
    this.updateExpiry(now);
    this.accumulatedMs = this.elapsedMs(now);
    this.segmentStart = null;
    this.pauseStartedAt = now;
    this.phase = 'paused';
    this.sawPause = true;
    return true;
  }

  resume(now: number): boolean {
    if (this.phase !== 'paused') return false;
    if (this.pauseStartedAt !== null) {
      this.pausedMs += Math.max(0, now - this.pauseStartedAt);
      this.pauseStartedAt = null;
    }
    this.segmentStart = now;
    this.phase = 'running';
    return true;
  }

  /**
   * Reset the current question's timing. `restart` (default true) begins a
   * fresh run immediately so the panel is never left in a dead state.
   */
  reset(now: number, restart = true): void {
    this.accumulatedMs = 0;
    this.segmentStart = null;
    this.pauseStartedAt = null;
    this.pausedMs = 0;
    this.startedAt = null;
    this.expiredAt = null;
    this.expiryNotified = false;
    this.firstSubmissionAt = null;
    this.firstSubmissionOutcome = null;
    this.sawPause = false;
    this.phase = 'idle';
    if (restart) this.start(now);
  }

  /** Freeze the timer and return final totals. */
  finish(now: number, _reason: EndReason): TimerSnapshot {
    if (this.phase === 'running') {
      this.updateExpiry(now);
      this.accumulatedMs = this.elapsedMs(now);
      this.segmentStart = null;
    } else if (this.phase === 'paused') {
      this.pausedMs = this.totalPausedMs(now);
      this.pauseStartedAt = null;
    }
    this.phase = 'finished';
    return this.snapshot(now);
  }

  /**
   * Switching mode mid-question keeps the elapsed time. Used when the user
   * changes the default mode from the popup while a question is in flight.
   */
  setMode(mode: TimerMode, limitMs: number | null, now: number): void {
    if (mode === this.mode && (mode === 'countup' || limitMs === this.limitMs)) return;
    this.mode = mode;
    if (mode === 'countup') {
      this.limitMs = null;
      this.expiredAt = null;
      this.expiryNotified = false;
    } else {
      this.limitMs = limitMs;
      if (this.limitMs === null) {
        this.expiredAt = null;
      } else if (this.elapsedMs(now) < this.limitMs) {
        // New limit is still in the future: clear any previous expiry.
        this.expiredAt = null;
        this.expiryNotified = false;
      } else if (this.expiredAt === null) {
        // Already past the new limit. If running we can still solve for the
        // exact crossing; otherwise the best available answer is "now".
        if (this.phase === 'running' && this.segmentStart !== null) {
          this.expiredAt = this.segmentStart + (this.limitMs - this.accumulatedMs);
        } else {
          this.expiredAt = now;
        }
      }
    }
    this.updateExpiry(now);
  }

  /**
   * Record the learner's first answer submission. Later calls are ignored so
   * that the *first* submission timestamp is preserved (spec 2.4).
   */
  markFirstSubmission(now: number, outcome: FirstSubmissionOutcome): boolean {
    if (this.firstSubmissionAt !== null) return false;
    this.firstSubmissionAt = now;
    this.firstSubmissionOutcome = outcome;
    return true;
  }

  /**
   * Refine the first submission's outcome once the page's feedback is readable.
   *
   * The submission timestamp is captured on the click, but Khan Academy renders
   * the correct/incorrect state a moment later, so the outcome arrives after
   * the fact. This never overwrites a known outcome, and never changes the
   * timestamp.
   */
  setFirstSubmissionOutcome(outcome: FirstSubmissionOutcome): boolean {
    if (this.firstSubmissionAt === null) return false;
    if (outcome === 'unknown') return false;
    if (this.firstSubmissionOutcome !== null && this.firstSubmissionOutcome !== 'unknown') {
      return false;
    }
    this.firstSubmissionOutcome = outcome;
    return true;
  }

  /* ---------------- ticks ---------------- */

  tick(now: number): TimerTick {
    const justExpired = this.updateExpiry(now);
    return {
      expiredJustNow: justExpired,
      expiredAt: this.expiredAt,
      snapshot: this.snapshot(now),
    };
  }

  /**
   * Detect the zero crossing. Returns true exactly once, on the first
   * observation of an expiry — this is what gates the single beep.
   */
  private updateExpiry(now: number): boolean {
    if (this.limitMs === null) return false;
    if (this.expiredAt === null) {
      if (this.phase !== 'running' || this.segmentStart === null) return false;
      // Solve segmentStart + (limitMs - accumulatedMs) = crossing instant.
      const crossing = this.segmentStart + (this.limitMs - this.accumulatedMs);
      if (crossing > now) return false;
      this.expiredAt = crossing;
    }
    if (this.expiryNotified) return false;
    this.expiryNotified = true;
    return true;
  }

  /* ---------------- persistence ---------------- */

  serialize(now: number): TimerSerialized {
    return {
      version: 1,
      mode: this.mode,
      phase: this.phase,
      questionKey: this.questionKey,
      exerciseKey: this.exerciseKey,
      startedAt: this.startedAt ?? now,
      accumulatedMs: this.elapsedMs(now),
      pausedMs: this.totalPausedMs(now),
      limitMs: this.limitMs,
      expiredAt: this.expiredAt,
      firstSubmissionAt: this.firstSubmissionAt,
      firstSubmissionOutcome: this.firstSubmissionOutcome,
      savedAt: now,
    };
  }

  /**
   * Rebuild a session saved before the page was closed.
   *
   * Product rule (spec 2.2, 12.5): time while the page is *open but hidden*
   * counts as real elapsed time, but time while the page is *closed* does not,
   * because the learner cannot be working. The saved elapsed time is therefore
   * carried over and counting continues from `now`.
   */
  static restore(saved: TimerSerialized, now: number): TimerEngine {
    const engine = new TimerEngine({
      mode: saved.mode,
      limitMs: saved.limitMs,
      questionKey: saved.questionKey,
      exerciseKey: saved.exerciseKey,
      now,
      autoStart: false,
    });
    engine.accumulatedMs = saved.accumulatedMs;
    engine.pausedMs = saved.pausedMs;
    engine.startedAt = saved.startedAt;
    engine.expiredAt = saved.expiredAt;
    engine.firstSubmissionAt = saved.firstSubmissionAt;
    engine.firstSubmissionOutcome = saved.firstSubmissionOutcome;

    const wasRunning = saved.phase === 'running' || saved.phase === 'idle';
    if (wasRunning) {
      engine.phase = 'running';
      engine.segmentStart = now;
    } else if (saved.phase === 'paused') {
      engine.phase = 'paused';
      engine.pauseStartedAt = now;
    } else {
      engine.phase = 'finished';
      engine.segmentStart = null;
    }
    // A restored session already past its limit must not re-fire the beep.
    if (engine.expiredAt !== null) engine.expiryNotified = true;
    engine.updateExpiry(now);
    return engine;
  }
}

/* ------------------------------------------------------------------ *
 * Formatting helpers (pure, so they are unit tested too)
 * ------------------------------------------------------------------ */

/** `m:ss` for under an hour, `h:mm:ss` beyond that. Negative input -> 0. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Whole seconds, rounded up, as shown on the countdown badge. */
export function ceilSeconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

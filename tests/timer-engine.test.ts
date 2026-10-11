/**
 * Timer engine tests.
 *
 * Spec 9 requires coverage of the counting engine, the state transitions, pause
 * and resume, and the behaviour when a tab is backgrounded or the machine
 * sleeps. Spec 5.3 requires that elapsed time never be derived from how many
 * times a timer callback fired — the central test here proves that by advancing
 * a fake clock by an hour without running a single tick.
 */

import { describe, expect, it } from 'vitest';
import { TimerEngine, ceilSeconds, formatDuration, type TimerEngineInit } from '../src/timer-engine.js';
import type { TimerSerialized } from '../src/types.js';

const T0 = 1_700_000_000_000; // fixed epoch, so tests are deterministic

function makeEngine(overrides: Partial<TimerEngineInit> = {}): TimerEngine {
  return new TimerEngine({
    mode: 'countup',
    limitMs: null,
    questionKey: 'id:q1',
    exerciseKey: 'e/addition_4',
    now: T0,
    ...overrides,
  });
}

describe('TimerEngine — countup', () => {
  it('starts running immediately and reports elapsed time from timestamps', () => {
    const engine = makeEngine();
    expect(engine.getPhase()).toBe('running');
    expect(engine.elapsedMs(T0)).toBe(0);
    expect(engine.elapsedMs(T0 + 5_000)).toBe(5_000);
  });

  it('accumulates elapsed time across a large clock jump without any ticks', () => {
    // The tab was hidden / the machine slept for an hour. No tick ran. The
    // reported elapsed time must still be the true wall-clock elapsed time.
    const engine = makeEngine();
    const oneHourLater = T0 + 60 * 60 * 1000;
    expect(engine.elapsedMs(oneHourLater)).toBe(3_600_000);
  });

  it('freezes the value while paused and resumes from the frozen value', () => {
    const engine = makeEngine();
    expect(engine.pause(T0 + 3_000)).toBe(true);
    expect(engine.getPhase()).toBe('paused');

    // Paused time must not accumulate, even across a long gap.
    expect(engine.elapsedMs(T0 + 300_000)).toBe(3_000);

    expect(engine.resume(T0 + 300_000)).toBe(true);
    expect(engine.elapsedMs(T0 + 302_000)).toBe(5_000);
    // Paused duration is tracked separately for the record.
    expect(engine.totalPausedMs(T0 + 302_000)).toBe(297_000);
  });

  it('ignores pause when not running and ignores resume when not paused', () => {
    const engine = makeEngine();
    expect(engine.resume(T0 + 1_000)).toBe(false);
    engine.pause(T0 + 1_000);
    expect(engine.pause(T0 + 2_000)).toBe(false);
  });

  it('an automatic pause freezes the clock without claiming the learner paused it', () => {
    // 识别：未识别 freezes the clock itself. The question's time must be
    // preserved and the frozen stretch must be reported as paused time, but
    // `wasPaused` ("the learner pressed 暂停") has to stay false.
    const engine = makeEngine();
    expect(engine.pause(T0 + 2_000, true)).toBe(true);
    expect(engine.getPhase()).toBe('paused');
    expect(engine.hasSeenPause()).toBe(false);
    expect(engine.elapsedMs(T0 + 42_000)).toBe(2_000);

    // Re-identifying the same question resumes from the frozen value.
    expect(engine.resume(T0 + 42_000)).toBe(true);
    expect(engine.elapsedMs(T0 + 45_000)).toBe(5_000);
    expect(engine.totalPausedMs(T0 + 45_000)).toBe(40_000);
    expect(engine.hasSeenPause()).toBe(false);

    const final = engine.finish(T0 + 45_000, 'question-change');
    expect(final.elapsedMs).toBe(5_000);
    expect(final.pausedMs).toBe(40_000);
    expect(engine.hasSeenPause()).toBe(false);
  });

  it('a learner pause still marks the question as paused', () => {
    const engine = makeEngine();
    engine.pause(T0 + 2_000);
    expect(engine.hasSeenPause()).toBe(true);
  });

  it('clamps a backwards clock jump to zero instead of going negative', () => {
    const engine = makeEngine();
    expect(engine.elapsedMs(T0 - 10_000)).toBe(0);
  });

  it('reset clears elapsed time and restarts by default', () => {
    const engine = makeEngine();
    engine.pause(T0 + 7_000);
    engine.reset(T0 + 9_000);
    expect(engine.getPhase()).toBe('running');
    expect(engine.elapsedMs(T0 + 9_000)).toBe(0);
    expect(engine.totalPausedMs(T0 + 9_000)).toBe(0);
  });

  it('reset can leave the timer idle', () => {
    const engine = makeEngine();
    engine.reset(T0 + 1_000, false);
    expect(engine.getPhase()).toBe('idle');
    expect(engine.elapsedMs(T0 + 9_000)).toBe(0);
  });

  it('finish freezes totals and excludes paused stretches from durationMs', () => {
    const engine = makeEngine();
    engine.pause(T0 + 2_000); // 2s counted
    engine.resume(T0 + 12_000); // 10s paused
    engine.pause(T0 + 15_000); // 3s counted while running
    const final = engine.finish(T0 + 15_000, 'question-change');

    expect(final.phase).toBe('finished');
    expect(final.elapsedMs).toBe(5_000);
    expect(final.pausedMs).toBe(10_000);
    expect(engine.hasSeenPause()).toBe(true);
  });
});

describe('TimerEngine — countdown', () => {
  it('reports remaining time and expires at the configured limit', () => {
    const engine = makeEngine({ mode: 'countdown', limitMs: 60_000 });
    expect(engine.remainingMs(T0 + 10_000)).toBe(50_000);
    expect(engine.isExpired()).toBe(false);

    const tick = engine.tick(T0 + 60_000);
    expect(tick.expiredJustNow).toBe(true);
    expect(tick.snapshot.expired).toBe(true);
    expect(tick.snapshot.remainingMs).toBe(0);
    expect(engine.remainingMs(T0 + 90_000)).toBe(0);
  });

  it('computes the exact expiry instant instead of the tick time', () => {
    // This is the "machine slept" case: no tick ran for an hour past the limit.
    // The recorded expiry must be the true crossing instant, not the late tick.
    const engine = makeEngine({ mode: 'countdown', limitMs: 60_000 });
    const tick = engine.tick(T0 + 3_600_000);
    expect(tick.expiredAt).toBe(T0 + 60_000);
    expect(tick.snapshot.expiredAt).toBe(T0 + 60_000);
    // Overrun is still measured from the true expiry.
    expect(tick.snapshot.overrunMs).toBe(3_540_000);
  });

  it('fires expiredJustNow exactly once so the tone cannot repeat', () => {
    const engine = makeEngine({ mode: 'countdown', limitMs: 10_000 });
    expect(engine.tick(T0 + 10_000).expiredJustNow).toBe(true);
    expect(engine.tick(T0 + 10_001).expiredJustNow).toBe(false);
    expect(engine.tick(T0 + 99_000).expiredJustNow).toBe(false);
  });

  it('resolves expiry correctly when the limit passes while paused is not possible', () => {
    // Pausing before the limit must freeze the countdown, not let it expire.
    const engine = makeEngine({ mode: 'countdown', limitMs: 10_000 });
    engine.pause(T0 + 4_000);
    expect(engine.tick(T0 + 500_000).expiredJustNow).toBe(false);
    expect(engine.remainingMs(T0 + 500_000)).toBe(6_000);
    // Resuming continues from 4s elapsed, so it expires 6s later.
    engine.resume(T0 + 500_000);
    expect(engine.tick(T0 + 505_000).expiredJustNow).toBe(false);
    expect(engine.tick(T0 + 506_000).expiredJustNow).toBe(true);
    expect(engine.snapshot(T0 + 506_000).expiredAt).toBe(T0 + 506_000);
  });

  it('keeps counting up past zero so overrun is visible', () => {
    const engine = makeEngine({ mode: 'countdown', limitMs: 5_000 });
    engine.tick(T0 + 8_000);
    const snapshot = engine.snapshot(T0 + 8_000);
    expect(snapshot.expired).toBe(true);
    expect(snapshot.elapsedMs).toBe(8_000);
    expect(snapshot.overrunMs).toBe(3_000);
  });

  it('switching mode mid-question preserves elapsed time', () => {
    const engine = makeEngine({ mode: 'countdown', limitMs: 10_000 });
    engine.setMode('countup', null, T0 + 4_000);
    expect(engine.getMode()).toBe('countup');
    expect(engine.getLimitMs()).toBeNull();
    expect(engine.elapsedMs(T0 + 6_000)).toBe(6_000);

    engine.setMode('countdown', 30_000, T0 + 6_000);
    expect(engine.remainingMs(T0 + 6_000)).toBe(24_000);
    expect(engine.snapshot(T0 + 6_000).expired).toBe(false);
  });
});

describe('TimerEngine — first submission (spec 2.4)', () => {
  it('records only the first submission timestamp', () => {
    const engine = makeEngine();
    expect(engine.markFirstSubmission(T0 + 4_000, 'unknown')).toBe(true);
    // A second submission must not overwrite the first timestamp.
    expect(engine.markFirstSubmission(T0 + 9_000, 'incorrect')).toBe(false);
    expect(engine.getFirstSubmission()).toEqual({ at: T0 + 4_000, outcome: 'unknown' });
  });

  it('refines the outcome later without changing the timestamp', () => {
    const engine = makeEngine();
    engine.markFirstSubmission(T0 + 4_000, 'unknown');
    // Feedback renders a moment after the click.
    expect(engine.setFirstSubmissionOutcome('incorrect')).toBe(true);
    expect(engine.getFirstSubmission()).toEqual({ at: T0 + 4_000, outcome: 'incorrect' });
    // A later, different outcome must not overwrite a settled one.
    expect(engine.setFirstSubmissionOutcome('correct')).toBe(false);
    expect(engine.getFirstSubmission()?.outcome).toBe('incorrect');
  });

  it('does not invent a submission when none happened', () => {
    const engine = makeEngine();
    expect(engine.setFirstSubmissionOutcome('correct')).toBe(false);
    expect(engine.getFirstSubmission()).toBeNull();
  });

  it('reset clears the submission record', () => {
    const engine = makeEngine();
    engine.markFirstSubmission(T0 + 1_000, 'incorrect');
    engine.reset(T0 + 2_000);
    expect(engine.getFirstSubmission()).toBeNull();
  });
});

describe('TimerEngine — persistence across a page reload (spec 2.2)', () => {
  it('round-trips a running session and continues from the saved elapsed time', () => {
    const engine = makeEngine();
    engine.pause(T0 + 3_000);
    engine.resume(T0 + 8_000);
    const saved = engine.serialize(T0 + 10_000);
    expect(saved.accumulatedMs).toBe(5_000);
    expect(saved.pausedMs).toBe(5_000);

    // The page was closed for an hour. Time while closed must NOT count.
    const reopenedAt = T0 + 3_600_000;
    const restored = TimerEngine.restore(saved, reopenedAt);
    expect(restored.getPhase()).toBe('running');
    expect(restored.elapsedMs(reopenedAt)).toBe(5_000);
    expect(restored.elapsedMs(reopenedAt + 2_000)).toBe(7_000);
    expect(restored.questionKey).toBe('id:q1');
  });

  it('restores a paused session as paused', () => {
    const engine = makeEngine();
    engine.pause(T0 + 2_000);
    const saved = engine.serialize(T0 + 2_000);
    const restored = TimerEngine.restore(saved, T0 + 100_000);
    expect(restored.getPhase()).toBe('paused');
    expect(restored.elapsedMs(T0 + 500_000)).toBe(2_000);
  });

  it('does not re-fire the expiry tone for an already expired session', () => {
    const engine = makeEngine({ mode: 'countdown', limitMs: 10_000 });
    engine.tick(T0 + 12_000);
    const saved = engine.serialize(T0 + 12_000);
    const restored = TimerEngine.restore(saved, T0 + 500_000);
    expect(restored.isExpired()).toBe(true);
    expect(restored.tick(T0 + 500_000).expiredJustNow).toBe(false);
  });

  it('preserves the first submission across a restore', () => {
    const engine = makeEngine();
    engine.markFirstSubmission(T0 + 1_500, 'incorrect');
    const saved: TimerSerialized = engine.serialize(T0 + 2_000);
    const restored = TimerEngine.restore(saved, T0 + 900_000);
    expect(restored.getFirstSubmission()).toEqual({ at: T0 + 1_500, outcome: 'incorrect' });
  });
});

describe('formatDuration / ceilSeconds', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(999)).toBe('0:00');
    expect(formatDuration(1_000)).toBe('0:01');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('adds an hours field only when needed', () => {
    expect(formatDuration(3_599_000)).toBe('59:59');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('clamps negative input to zero', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
  });

  it('ceils to whole seconds for the countdown badge', () => {
    expect(ceilSeconds(0)).toBe(0);
    expect(ceilSeconds(1)).toBe(1);
    expect(ceilSeconds(1_001)).toBe(2);
    expect(ceilSeconds(59_999)).toBe(60);
  });
});

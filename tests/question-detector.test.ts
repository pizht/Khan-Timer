/**
 * Question detection tests.
 *
 * Two layers are covered:
 *
 *  1. `QuestionChangeDecider` — the pure decision logic, tested directly with
 *     synthetic snapshots.
 *  2. `QuestionDetector` — the DOM adapter, driven against a synthetic DOM that
 *     mirrors the structure actually observed on Khan Academy
 *     (see references/snapshots/ and references/observations.md).
 *
 * The regression block near the end encodes the two most important empirical
 * findings from live observation. Both are cases where a naive implementation
 * would wrongly reset the timer, so they are locked in as tests:
 *
 *   - submitting an answer changes the progress marker's STATE segment
 *     (`incomplete` -> `correct`), which must NOT count as a question change;
 *   - opening hints/solutions exploded the question region's text from ~3.5 KB
 *     to ~23 KB, which must NOT count as a question change either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QuestionChangeDecider,
  QuestionDetector,
  buildQuestionIdentity,
  identityKeyOf,
} from '../src/question-detector.js';
import {
  exerciseKeyFromUrl,
  progressLabel,
  readProgress,
  readSubmissionOutcome,
} from '../src/site-profile.js';
import type { DetectionEvent, QuestionSnapshot } from '../src/types.js';

const T0 = 1_700_000_000_000;

/** Build a snapshot with sensible defaults, overriding what a test cares about. */
function snap(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    at: T0,
    stableId: null,
    fingerprint: null,
    progress: null,
    url: 'https://www.khanacademy.org/math/x/e/addition_4',
    regionFound: true,
    strategy: 'perseus-answerform',
    confidence: 'none',
    ...overrides,
  };
}

/** A snapshot whose identity comes from the progress marker, as on real pages. */
function progressSnap(index: number, total: number, at: number): QuestionSnapshot {
  return snap({
    at,
    stableId: `progress:${index + 1} of ${total}`,
    progress: `${index + 1} of ${total}`,
    confidence: 'stable-id',
  });
}

/** A snapshot whose identity comes from the fallback fingerprint. */
function fingerprintSnap(fingerprint: string, at: number): QuestionSnapshot {
  return snap({ at, fingerprint, confidence: 'fingerprint' });
}

describe('buildQuestionIdentity', () => {
  it('prefers a site-provided stable id', () => {
    const identity = buildQuestionIdentity({
      stemText: 'Add. 608+251',
      widgetSignature: 'text=1',
      progress: '1 of 4',
      stableId: 'abc123',
    });
    expect(identity).toEqual({ key: 'id:abc123', confidence: 'stable-id' });
  });

  it('falls back to a fingerprint over stem, widget shape and progress', () => {
    const identity = buildQuestionIdentity({
      stemText: 'Add. 608+251',
      widgetSignature: 'text=1',
      progress: '1 of 4',
      stableId: null,
    });
    expect(identity?.confidence).toBe('fingerprint');
    expect(identity?.key.startsWith('fp:')).toBe(true);
  });

  it('produces different fingerprints for different stems', () => {
    const a = buildQuestionIdentity({ stemText: 'Add. 608+251', widgetSignature: 'text=1', progress: '1 of 4', stableId: null });
    const b = buildQuestionIdentity({ stemText: 'Add. 832+95', widgetSignature: 'text=1', progress: '1 of 4', stableId: null });
    expect(a?.key).not.toBe(b?.key);
  });

  it('distinguishes otherwise identical stems by progress marker (spec 12.3)', () => {
    const q3 = buildQuestionIdentity({ stemText: 'Add. 1+1', widgetSignature: 'text=1', progress: '3 of 7', stableId: null });
    const q4 = buildQuestionIdentity({ stemText: 'Add. 1+1', widgetSignature: 'text=1', progress: '4 of 7', stableId: null });
    expect(q3?.key).not.toBe(q4?.key);
  });

  it('ignores cosmetic whitespace differences in the stem', () => {
    const a = buildQuestionIdentity({ stemText: 'Add.  608 + 251', widgetSignature: 'text=1', progress: '1 of 4', stableId: null });
    const b = buildQuestionIdentity({ stemText: ' Add.\n608 + 251 ', widgetSignature: 'text=1', progress: '1 of 4', stableId: null });
    expect(a?.key).toBe(b?.key);
  });

  it('uses the progress marker alone when there is no stem or widget shape', () => {
    const identity = buildQuestionIdentity({ stemText: '', widgetSignature: '', progress: '2 of 5', stableId: null });
    expect(identity).toEqual({ key: 'prog:2 of 5', confidence: 'weak' });
  });

  it('returns null when nothing usable is available', () => {
    expect(buildQuestionIdentity({ stemText: '', widgetSignature: '', progress: null, stableId: null })).toBeNull();
  });
});

describe('identityKeyOf', () => {
  it('prefers stableId over fingerprint', () => {
    expect(identityKeyOf(snap({ stableId: 'x', fingerprint: 'y' }))).toBe('id:x');
  });

  it('falls back to the fingerprint', () => {
    expect(identityKeyOf(snap({ fingerprint: 'y' }))).toBe('fp:y');
  });

  it('returns null when neither exists', () => {
    expect(identityKeyOf(snap())).toBeNull();
  });
});

describe('QuestionChangeDecider', () => {
  let decider: QuestionChangeDecider;
  let events: DetectionEvent[];

  const observe = (s: QuestionSnapshot): DetectionEvent => {
    const event = decider.observe(s);
    events.push(event);
    return event;
  };

  beforeEach(() => {
    decider = new QuestionChangeDecider({ debounceMs: 400, cooldownMs: 1200 });
    events = [];
  });

  it('emits an initial question-changed with from === null', () => {
    const event = observe(progressSnap(0, 4, T0));
    expect(event).toMatchObject({ type: 'question-changed', from: null, reason: 'initial' });
    expect(decider.getCurrent()?.key).toBe('id:progress:1 of 4');
  });

  it('reports the same question while the identity is unchanged', () => {
    observe(progressSnap(0, 4, T0));
    expect(observe(progressSnap(0, 4, T0 + 500))).toMatchObject({ type: 'same-question' });
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(1);
  });

  it('requires a candidate to stay stable for the de-bounce window', () => {
    observe(progressSnap(0, 4, T0));
    // First sighting of the new identity: only a candidate.
    expect(observe(progressSnap(1, 4, T0 + 5000))).toMatchObject({ type: 'pending' });
    // Still inside the de-bounce window.
    expect(observe(progressSnap(1, 4, T0 + 5100))).toMatchObject({ type: 'pending' });
    // Now stable for >= 400ms: commit.
    expect(observe(progressSnap(1, 4, T0 + 5400))).toMatchObject({
      type: 'question-changed',
      reason: 'stable-change',
    });
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(2);
  });

  it('suppresses duplicates: many observations of one change yield one event', () => {
    observe(progressSnap(0, 4, T0));
    for (let i = 1; i <= 50; i += 1) observe(progressSnap(1, 4, T0 + 5000 + i * 20));
    const changes = events.filter((e) => e.type === 'question-changed');
    expect(changes).toHaveLength(2); // initial + exactly one real change
  });

  it('does not switch on an A -> B -> A flap', () => {
    observe(progressSnap(0, 4, T0));
    observe(progressSnap(1, 4, T0 + 2000)); // candidate B
    observe(progressSnap(0, 4, T0 + 2100)); // back to A: candidate dropped
    observe(progressSnap(1, 4, T0 + 2200)); // candidate B again
    observe(progressSnap(0, 4, T0 + 2300));
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(1);
    expect(decider.getCurrent()?.key).toBe('id:progress:1 of 4');
  });

  it('respects the cooldown between two accepted changes', () => {
    observe(progressSnap(0, 4, T0));
    // Commit change to index 1 at T0+1000.
    observe(progressSnap(1, 4, T0 + 1000));
    expect(observe(progressSnap(1, 4, T0 + 1450))).toMatchObject({ type: 'question-changed' });

    // A second change immediately after is held back by the cooldown.
    observe(progressSnap(2, 4, T0 + 1500));
    expect(observe(progressSnap(2, 4, T0 + 1900))).toMatchObject({ type: 'pending' });
    // Once the cooldown (1200ms since the last switch at ~1450) has elapsed, commit.
    expect(observe(progressSnap(2, 4, T0 + 2800))).toMatchObject({ type: 'question-changed' });
  });

  it('degrades conservatively when no question region is found', () => {
    const event = observe(snap({ regionFound: false, confidence: 'none' }));
    expect(event).toMatchObject({ type: 'uncertain' });
    expect(decider.getCurrent()).toBeNull();
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(0);
  });

  it('keeps the current timer when the identity disappears mid-question', () => {
    observe(progressSnap(0, 4, T0));
    const event = observe(snap({ regionFound: false, at: T0 + 5000 }));
    expect(event).toMatchObject({ type: 'uncertain' });
    // Crucially: still on the same question, so timing is not restarted.
    expect(decider.getCurrent()?.key).toBe('id:progress:1 of 4');
  });

  it('reports uncertain when no identity signal is available', () => {
    observe(progressSnap(0, 4, T0));
    expect(observe(snap({ at: T0 + 5000 }))).toMatchObject({
      type: 'uncertain',
      reason: expect.stringContaining('no stable identity'),
    });
    expect(decider.getCurrent()?.key).toBe('id:progress:1 of 4');
  });

  it('commits immediately on forceSwitch (explicit navigation)', () => {
    observe(progressSnap(0, 4, T0));
    const event = decider.forceSwitch('id:progress:3 of 4', T0 + 100, 'url-change');
    expect(event).toMatchObject({ type: 'question-changed', reason: 'url-change' });
    // Forcing the same key is a no-op rather than a spurious switch.
    expect(decider.forceSwitch('id:progress:3 of 4', T0 + 200, 'url-change')).toMatchObject({
      type: 'same-question',
    });
  });

  it('reseed restarts even when the identity is unchanged ("Start over")', () => {
    observe(progressSnap(0, 4, T0));
    decider.reseed();
    const event = observe(progressSnap(0, 4, T0 + 9000));
    expect(event).toMatchObject({ type: 'question-changed', reason: 'reseeded', to: 'id:progress:1 of 4' });
  });

  it('reset forgets everything so the next observation is initial', () => {
    observe(progressSnap(2, 4, T0));
    decider.reset();
    expect(decider.getCurrent()).toBeNull();
    expect(observe(progressSnap(0, 4, T0 + 1000))).toMatchObject({ type: 'question-changed', from: null });
  });

  it('configure updates the windows at runtime', () => {
    decider.configure({ debounceMs: 0, cooldownMs: 0 });
    observe(progressSnap(0, 4, T0));
    observe(progressSnap(1, 4, T0 + 1)); // sets candidate
    expect(observe(progressSnap(1, 4, T0 + 1))).toMatchObject({ type: 'question-changed' });
  });

  it('reports whether a candidate change is awaiting confirmation', () => {
    observe(progressSnap(0, 4, T0));
    expect(decider.hasPendingCandidate()).toBe(false);
    observe(progressSnap(1, 4, T0 + 2000));
    expect(decider.hasPendingCandidate()).toBe(true);
    observe(progressSnap(1, 4, T0 + 2600));
    expect(decider.hasPendingCandidate()).toBe(false);
  });
});

/* ================================================================== *
 * DOM adapter
 * ================================================================== */

/**
 * Synthetic page mirroring the real structure. The testids, class names and
 * nesting were all taken from captured Khan Academy DOM.
 */
function khanDom({
  progressIndex = 0,
  progressState = 'incomplete',
  progressTotal = 4,
  stem = 'Add. 608+251',
  withProgress = true,
  withFeedbackDialog = false,
} = {}): string {
  const cells = Array.from({ length: progressTotal }, (_, i) => {
    const state = i === progressIndex ? `${progressState}-current` : 'incomplete';
    return `<div><div data-testid="exercise-progress-${i}-${state}"></div></div>`;
  }).join('');

  return `
    <div data-testid="content-panel-wrapper">
      <div class="bibliotron-exercise">
        <div class="framework-perseus">
          <h2 class="sr-only">Problem</h2>
          <form name="answerform">
            <div class="perseus-renderer perseus-renderer-responsive">
              <div class="paragraph" data-perseus-paragraph-index="0">${stem}</div>
              <div class="perseus-widget-container widget-inline-block">
                <input type="text" class="perseus-input" data-testid="input-with-examples" />
              </div>
            </div>
          </form>
        </div>
      </div>
      ${
        withFeedbackDialog
          ? `<div role="dialog"><h4>Not quite yet...</h4><span>Give it another try!</span></div>`
          : ''
      }
      <div data-testid="content-library-footer">
        ${withProgress ? `<div class="progress">${cells}</div>` : ''}
        <div>
          <button data-testid="exercise-skip-button">Skip</button>
          <button data-testid="exercise-check-answer"><span>Check</span></button>
        </div>
      </div>
    </div>
  `;
}

describe('QuestionDetector — DOM adapter', () => {
  let detector: QuestionDetector;
  let events: DetectionEvent[];

  const start = (html: string, options = { debounceMs: 400, cooldownMs: 1200 }): void => {
    document.body.innerHTML = html;
    events = [];
    detector = new QuestionDetector({ onEvent: (event) => events.push(event) }, options);
    detector.start();
  };

  const last = (): DetectionEvent => {
    const event = events[events.length - 1];
    if (!event) throw new Error('no detection event recorded');
    return event;
  };

  const currentTestId = (index: number): string => {
    const el = document.querySelector('[data-testid^="exercise-progress-"]');
    if (!el) throw new Error('no progress cell');
    return el.getAttribute('data-testid') ?? '';
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('finds the question region via form[name="answerform"]', () => {
    start(khanDom());
    expect(last()).toMatchObject({ type: 'question-changed', from: null });
    expect(detector.getCurrentKey()).toBe('id:progress:1 of 4');
  });

  it('uses the progress index as the identity, not the volatile state segment', () => {
    start(khanDom({ progressState: 'incomplete' }));
    expect(detector.getCurrentKey()).toBe('id:progress:1 of 4');

    // Simulate submitting an answer: only the STATE segment changes.
    const cell = document.querySelector('[data-testid="exercise-progress-0-incomplete-current"]');
    expect(cell).not.toBeNull();
    cell?.setAttribute('data-testid', 'exercise-progress-0-correct-current');
    vi.setSystemTime(T0 + 3000);
    detector.reevaluate('after-submit');

    expect(last()).toMatchObject({ type: 'same-question' });
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(1);
  });

  it('advances only after the new index is stable for the de-bounce window', () => {
    start(khanDom({ progressIndex: 0 }));
    // Advance: index 0 -> 1 and a new stem.
    document
      .querySelector('[data-testid="exercise-progress-0-incomplete-current"]')
      ?.setAttribute('data-testid', 'exercise-progress-0-correct');
    document
      .querySelector('[data-testid="exercise-progress-1-incomplete"]')
      ?.setAttribute('data-testid', 'exercise-progress-1-incomplete-current');
    const stemEl = document.querySelector('[data-perseus-paragraph-index]');
    if (stemEl) stemEl.textContent = 'Add. 832+95';

    vi.setSystemTime(T0 + 10_000);
    detector.reevaluate('advance-seen');
    expect(last()).toMatchObject({ type: 'pending' });

    vi.setSystemTime(T0 + 10_400);
    detector.reevaluate('advance-stable');
    expect(last()).toMatchObject({ type: 'question-changed', reason: 'stable-change' });
    expect(detector.getCurrentKey()).toBe('id:progress:2 of 4');
  });

  it('confirms a pending change by itself, with no further DOM mutations', () => {
    // REGRESSION: the de-bounce requires a *second* observation once the window
    // has elapsed. The mutation that revealed the change has already been
    // consumed by then, so without an explicit follow-up the candidate sat
    // unconfirmed forever and the panel kept timing the previous question.
    // Caught by scripts/verify-extension.mjs against the real site.
    start(khanDom({ progressIndex: 0 }));

    document
      .querySelector('[data-testid="exercise-progress-0-incomplete-current"]')
      ?.setAttribute('data-testid', 'exercise-progress-0-correct');
    document
      .querySelector('[data-testid="exercise-progress-1-incomplete"]')
      ?.setAttribute('data-testid', 'exercise-progress-1-incomplete-current');

    vi.setSystemTime(T0 + 10_000);
    detector.reevaluate('advance-seen');
    expect(last()).toMatchObject({ type: 'pending' });

    // Nothing else touches the DOM. Only the scheduled follow-up can confirm.
    vi.advanceTimersByTime(500);
    expect(last()).toMatchObject({ type: 'question-changed', reason: 'stable-change' });
    expect(detector.getCurrentKey()).toBe('id:progress:2 of 4');
  });

  it('does not keep re-evaluating once a candidate is resolved', () => {
    start(khanDom({ progressIndex: 0 }));
    document
      .querySelector('[data-testid="exercise-progress-0-incomplete-current"]')
      ?.setAttribute('data-testid', 'exercise-progress-0-correct');
    document
      .querySelector('[data-testid="exercise-progress-1-incomplete"]')
      ?.setAttribute('data-testid', 'exercise-progress-1-incomplete-current');
    vi.setSystemTime(T0 + 10_000);
    detector.reevaluate('advance-seen');
    vi.advanceTimersByTime(600);
    const settled = events.length;
    // Let a lot of time pass with no DOM changes and no pending candidate:
    // the poll must not keep emitting detections.
    vi.advanceTimersByTime(30_000);
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(2);
    expect(events.length).toBeLessThan(settled + 12);
  });

  it('goes uncertain, and keeps timing, when the region disappears', () => {
    start(khanDom());
    document.querySelector('form[name="answerform"]')?.remove();
    document.querySelector('.framework-perseus')?.remove();
    document.querySelector('.perseus-renderer')?.remove();

    vi.setSystemTime(T0 + 5000);
    detector.reevaluate('region-gone');

    expect(last()).toMatchObject({ type: 'uncertain' });
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(1);
  });

  it('reseed emits a change for the same identity ("Start over")', () => {
    start(khanDom());
    vi.setSystemTime(T0 + 20_000);
    detector.reseed('start-over');
    expect(last()).toMatchObject({ type: 'question-changed', reason: 'reseeded' });
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(2);
  });

  it('reports fingerprint confidence when the page exposes no progress marker', () => {
    start(khanDom({ withProgress: false }));
    expect(last()).toMatchObject({ type: 'question-changed' });
    expect(detector.getCurrentKey()?.startsWith('fp:')).toBe(true);
  });
});

/* ================================================================== *
 * Regressions from live observation
 * ================================================================== */

describe('REGRESSION — auxiliary content must not reset the timer (spec 2.4, 8.3)', () => {
  let detector: QuestionDetector;
  let events: DetectionEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const start = (html: string): void => {
    document.body.innerHTML = html;
    events = [];
    detector = new QuestionDetector(
      { onEvent: (e) => events.push(e) },
      { debounceMs: 400, cooldownMs: 1200 },
    );
    detector.start();
  };

  it('hint expansion that grows the region 3.5 KB -> 23 KB is NOT a question change', () => {
    // Observed for real: after confirming "Yes, skip", all hints for the
    // current question expanded INSIDE form[name="answerform"], and the region
    // text grew from ~3.5 KB to ~23 KB while the progress index stayed put.
    start(khanDom());

    const form = document.querySelector('form[name="answerform"]');
    expect(form).not.toBeNull();
    const hints = document.createElement('div');
    hints.className = 'hints-container';
    hints.innerHTML = Array.from(
      { length: 40 },
      (_, i) =>
        `<div>Hint #${i + 1} ${i + 1}/4 Step ${i}: 608 + 251 = 859 with a long explanation of place value regrouping.</div>`,
    ).join('');
    form?.appendChild(hints);

    vi.setSystemTime(T0 + 15_000);
    detector.reevaluate('hints-open');
    expect(events[events.length - 1]).toMatchObject({ type: 'same-question' });

    // And again a moment later, to be sure nothing settles into a switch.
    vi.setSystemTime(T0 + 20_000);
    detector.reevaluate('hints-settled');
    expect(events.filter((e) => e.type === 'question-changed')).toHaveLength(1);
  });

  it('an incorrect-answer popover is NOT a question change', () => {
    start(khanDom());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h4>Not quite yet...</h4><span>Give it another try!</span>';
    document.querySelector('form[name="answerform"]')?.appendChild(dialog);

    vi.setSystemTime(T0 + 6000);
    detector.reevaluate('feedback-shown');
    expect(events[events.length - 1]).toMatchObject({ type: 'same-question' });
  });

  it('the fallback fingerprint ignores feedback text when there is no progress marker', () => {
    start(khanDom({ withProgress: false }));
    const keyBefore = detector.getCurrentKey();
    expect(keyBefore?.startsWith('fp:')).toBe(true);

    // Feedback arrives inside the region (worst case) with no progress marker.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h4>There you go!</h4><span>Keep it up!</span>';
    document.querySelector('form[name="answerform"]')?.appendChild(dialog);

    vi.setSystemTime(T0 + 6000);
    detector.reevaluate('feedback-fingerprint-path');
    expect(events[events.length - 1]).toMatchObject({ type: 'same-question' });
    expect(detector.getCurrentKey()).toBe(keyBefore);
  });

  it('typing an answer into the widget is NOT a question change', () => {
    start(khanDom());
    const input = document.querySelector<HTMLInputElement>('[data-testid="input-with-examples"]');
    expect(input).not.toBeNull();
    if (input) input.value = '859';

    vi.setSystemTime(T0 + 4000);
    detector.reevaluate('answer-typed');
    expect(events[events.length - 1]).toMatchObject({ type: 'same-question' });
  });
});

/* ================================================================== *
 * Site profile helpers
 * ================================================================== */

describe('site-profile: readProgress / progressLabel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the index and ignores the state word', () => {
    document.body.innerHTML = khanDom({ progressIndex: 2, progressState: 'incorrect' });
    const progress = readProgress(document);
    expect(progress).toMatchObject({ index: 2, total: 4, state: 'incorrect' });
    expect(progressLabel(progress)).toBe('3 of 4');
  });

  it('returns null when there is no progress marker', () => {
    document.body.innerHTML = khanDom({ withProgress: false });
    expect(readProgress(document)).toBeNull();
    expect(progressLabel(null)).toBeNull();
  });

  it('labels a lone progress cell without a total', () => {
    document.body.innerHTML = khanDom({ progressTotal: 1, progressIndex: 0 });
    expect(progressLabel(readProgress(document))).toBe('1 of 1');
  });
});

describe('site-profile: readSubmissionOutcome', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads "incorrect" from the progress state', () => {
    document.body.innerHTML = khanDom({ progressState: 'incorrect' });
    expect(readSubmissionOutcome(document)).toBe('incorrect');
  });

  it('reads "correct" from the progress state', () => {
    document.body.innerHTML = khanDom({ progressState: 'correct' });
    expect(readSubmissionOutcome(document)).toBe('correct');
  });

  it('is unknown while the question is still unattempted', () => {
    document.body.innerHTML = khanDom({ progressState: 'incomplete' });
    expect(readSubmissionOutcome(document)).toBe('unknown');
  });
});

describe('site-profile: exerciseKeyFromUrl', () => {
  const base = 'https://www.khanacademy.org';

  it('keeps the course/unit/type/slug path for an exercise', () => {
    expect(
      exerciseKeyFromUrl(
        `${base}/math/cc-third-grade-math/imp-adding-with-regrouping-within-1000/e/addition_4`,
      ),
    ).toBe('/math/cc-third-grade-math/imp-adding-with-regrouping-within-1000/e/addition_4');
  });

  it('handles quiz and unit-test paths', () => {
    expect(exerciseKeyFromUrl(`${base}/math/x/imp-rounding/quiz/quiz-1`)).toBe('/math/x/imp-rounding/quiz/quiz-1');
    expect(exerciseKeyFromUrl(`${base}/math/x/test/unit-test`)).toBe('/math/x/test/unit-test');
  });

  it('drops query strings and fragments (e.g. ?referrer=upsell)', () => {
    expect(exerciseKeyFromUrl(`${base}/math/x/quiz/quiz-1?referrer=upsell`)).toBe('/math/x/quiz/quiz-1');
  });

  it('appends the page-declared exercise id when present (spec 12.1)', () => {
    document.body.innerHTML = '<div data-exercise-id="2002"></div>';
    expect(exerciseKeyFromUrl(`${base}/math/x/e/addition_4`, document)).toBe(
      '/math/x/e/addition_4#2002',
    );
  });

  it('falls back to the path for non-exercise pages', () => {
    expect(exerciseKeyFromUrl(`${base}/math/cc-third-grade-math`)).toBe('/math/cc-third-grade-math');
  });

  it('does not throw on an unparseable URL', () => {
    expect(exerciseKeyFromUrl('not a url')).toBe('not a url');
  });
});

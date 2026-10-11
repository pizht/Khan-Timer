/**
 * Coordinator tests: what happens to a question that is being timed when the
 * learner leaves it for another practice.
 *
 * These are the regression tests for the reported bug:
 *
 *   "Practice A: several questions done, not finished. Switching to practice B,
 *    the 'Ready to practice?' screen showed practice A's clock, and coming back
 *    to practice A the timing data was gone."
 *
 * Two separate losses were possible, and both are covered here:
 *
 *  1. the engine of the exercise that was left stayed alive, so its clock kept
 *     running (and was rendered) on the new exercise's start card;
 *  2. the question being timed was dropped - either its held record (a question
 *     already answered or skipped) or its accumulated time (a question still
 *     being answered) never reached storage.
 *
 * The coordinator is driven exactly as the content script drives it: a synthetic
 * Khan Academy DOM, a stubbed `chrome.storage.local`, and jsdom's own URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentController } from '../src/controller.js';
import { OVERLAY_HOST_ID } from '../src/question-detector.js';
import { sessionKey } from '../src/storage.js';

const T0 = 1_700_000_000_000;
const EXERCISE_A = '/math/cc-third-grade-math/imp-addition-and-subtraction/e/addition_4';
const EXERCISE_B = '/math/cc-third-grade-math/imp-addition-and-subtraction/e/subtraction_4';

/* ------------------------------------------------------------------ *
 * Synthetic Khan Academy pages
 * ------------------------------------------------------------------ */

function progressCells(index: number, total: number, state: string): string {
  return Array.from({ length: total }, (_, i) => {
    const cellState = i === index ? `${state}-current` : 'incomplete';
    return `<div><div data-testid="exercise-progress-${i}-${cellState}"></div></div>`;
  }).join('');
}

function exerciseDom({
  index = 0,
  total = 4,
  state = 'incomplete',
  stem = 'Add. 608+251',
} = {}): string {
  return `
    <div class="bibliotron-exercise">
      <div class="framework-perseus">
        <form name="answerform">
          <div class="perseus-renderer perseus-renderer-responsive">
            <div data-perseus-paragraph-index="0">${stem}</div>
            <div class="perseus-widget-container widget-inline-block">
              <input type="text" class="perseus-input" />
            </div>
          </div>
        </form>
      </div>
      <div data-testid="content-library-footer">
        <div class="progress">${progressCells(index, total, state)}</div>
        <button data-testid="exercise-skip-button">Skip</button>
        <button data-testid="exercise-check-answer">Check</button>
      </div>
    </div>`;
}

/** The intro card a not-yet-started exercise shows: no question, no progress. */
function startCardDom(): string {
  return `
    <div class="bibliotron-exercise">
      <div data-testid="start-task-card-summary">
        <h2>Ready to practice?</h2>
        <button>Let\u2019s go</button>
      </div>
    </div>`;
}

/**
 * Replace the page's content the way an SPA route change does, WITHOUT touching
 * the overlay host the controller mounted on `document.body`.
 */
function setPage(html: string): void {
  let root = document.getElementById('page-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'page-root';
    document.body.appendChild(root);
  }
  root.innerHTML = html;
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface ChromeStub {
  data: Record<string, unknown>;
}

/** In-memory `chrome.storage.local`, enough for the coordinator's real flow. */
function installChromeStorage(): ChromeStub {
  const data: Record<string, unknown> = {};
  const local = {
    async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(data, items);
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
  };
  vi.stubGlobal('chrome', {
    storage: { local, onChanged: { addListener: () => undefined } },
    runtime: { onMessage: { addListener: () => undefined } },
  });
  return { data };
}

/** Let wall-clock time pass, flushing the microtasks timers/mutations produce. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function overlayHost(): HTMLElement | null {
  return document.getElementById(OVERLAY_HOST_ID);
}

/** Is the floating panel actually on screen? */
function panelVisible(): boolean {
  const host = overlayHost();
  return host !== null && host.style.display !== 'none';
}

/** The value the learner sees in the panel, back in milliseconds. */
function displayedMs(): number {
  const text = overlayHost()?.shadowRoot?.querySelector('[data-role="time"]')?.textContent ?? '';
  const [minutes = Number.NaN, seconds = Number.NaN] = text.split(':').map((part) => Number(part));
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return Number.NaN;
  return (minutes * 60 + seconds) * 1000;
}

function savedSession(data: Record<string, unknown>, exerciseKey: string): Record<string, unknown> {
  return (data[sessionKey(exerciseKey)] ?? {}) as Record<string, unknown>;
}

function savedRecords(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((data['records'] as { records?: Array<Record<string, unknown>> } | undefined)?.records ??
    []) as Array<Record<string, unknown>>;
}

let controller: ContentController | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  document.body.innerHTML = '';
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/');
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('leaving a practice for another one', () => {
  it('never shows the previous practice clock, and keeps its time for when the learner returns', async () => {
    const { data } = installChromeStorage();

    // Practice A: question 4 of 7, being answered.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 3, total: 7 }));
    controller = new ContentController();
    await controller.init();
    await advance(1000);

    expect(panelVisible()).toBe(true);
    expect(displayedMs()).toBeLessThan(2000);

    // 30 seconds of work on that question.
    await advance(30_000);
    expect(displayedMs()).toBeGreaterThanOrEqual(30_000);

    // The learner switches to practice B, which shows its intro card.
    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardDom());
    await advance(1000);

    // The clock of practice A is not rendered on practice B's start card ...
    expect(panelVisible()).toBe(false);
    // ... and it was frozen, not thrown away. (The engine was started during
    // the initial settle, so it holds ~31s by the time it is parked.)
    const parked = savedSession(data, EXERCISE_A);
    expect(parked['questionKey']).toBe('id:progress:4 of 7');
    expect(parked['phase']).toBe('running');
    expect(parked['accumulatedMs']).toBeGreaterThanOrEqual(30_000);
    expect(parked['accumulatedMs']).toBeLessThan(32_000);

    // Ten minutes in practice B must not be counted as time on practice A's
    // question.
    await advance(10 * 60_000);
    expect(savedSession(data, EXERCISE_A)['accumulatedMs']).toBeLessThan(32_000);

    // Back to practice A, same question: the clock carries on where it stopped.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 3, total: 7 }));
    await advance(2000);

    expect(panelVisible()).toBe(true);
    expect(displayedMs()).toBeGreaterThanOrEqual(30_000);
    expect(displayedMs()).toBeLessThan(36_000);
  });

  it('keeps practising in the exercise it arrived at', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);

    // Straight to practice B's first question, with no intro card in between.
    window.history.pushState({}, '', EXERCISE_B);
    setPage(exerciseDom({ index: 0, total: 4, stem: 'Subtract. 400-251' }));
    await advance(2000);

    // Practice A keeps its own session, practice B times its own question.
    expect(savedSession(data, EXERCISE_A)['exerciseKey']).toBe(EXERCISE_A);
    expect(savedSession(data, EXERCISE_B)['exerciseKey']).toBe(EXERCISE_B);
    expect(savedSession(data, EXERCISE_B)['accumulatedMs']).toBeLessThan(3000);
    expect(panelVisible()).toBe(true);
  });

  it('saves the question the learner had already answered before switching away', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);

    // The learner submits and the page grades the answer correct; the record is
    // held back until the question actually changes.
    document
      .querySelector('[data-testid="exercise-check-answer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document
      .querySelector('[data-testid="exercise-progress-0-incomplete-current"]')
      ?.setAttribute('data-testid', 'exercise-progress-0-correct-current');
    await advance(3000);

    expect(savedRecords(data)).toHaveLength(0);

    // Instead of advancing, the learner leaves for practice B.
    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardDom());
    await advance(1000);

    const records = savedRecords(data);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      exerciseKey: EXERCISE_A,
      questionKey: 'id:progress:1 of 4',
      endReason: 'answered-correct',
      firstSubmissionOutcome: 'correct',
      questionIndex: 0,
    });
    expect(records[0]?.['durationMs']).toBeGreaterThanOrEqual(3000);
    // The finished question is no longer resumable.
    expect(data[sessionKey(EXERCISE_A)]).toBeUndefined();
    expect(panelVisible()).toBe(false);
  });
});

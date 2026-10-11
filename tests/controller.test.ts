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
import { SUMMARY_HOST_ID } from '../src/summary-view.js';

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
 * The exercise chrome with the question area momentarily gone — what the page
 * looks like while the SPA swaps a question, and the state the panel labels
 * 识别：未识别.
 *
 * Deliberately keeps the progress cells and the Check button: without them the
 * page would also satisfy `isSummaryPage` and be mistaken for the end of the
 * exercise.
 */
function interimDom({ index = 0, total = 4 } = {}): string {
  return `
    <div class="bibliotron-exercise">
      <div data-testid="content-library-footer">
        <div class="progress">${progressCells(index, total, 'incomplete')}</div>
        <button data-testid="exercise-check-answer">Check</button>
      </div>
    </div>`;
}

/** The end-of-exercise screen: chrome, no question, no progress markers. */
function summaryDom(): string {
  return `
    <div class="bibliotron-exercise">
      <h2>Exercise complete!</h2>
      <p>4 of 4 correct</p>
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

/** The panel's own 暂停/继续 control, as the learner sees its label. */
function pauseLabel(): string {
  return (
    overlayHost()?.shadowRoot?.querySelector('[data-role="pause"]')?.textContent?.trim() ?? ''
  );
}

/** Click a control inside the panel's Shadow DOM, as a learner would. */
function clickOverlay(role: string): void {
  const button = overlayHost()?.shadowRoot?.querySelector(`[data-role="${role}"]`);
  if (!button) throw new Error(`overlay has no [data-role="${role}"]`);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Answer the question on screen correctly, the way the page reports it. */
function answerCorrectly(index: number): void {
  document
    .querySelector('[data-testid="exercise-check-answer"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document
    .querySelector(`[data-testid="exercise-progress-${index}-incomplete-current"]`)
    ?.setAttribute('data-testid', `exercise-progress-${index}-correct-current`);
}

/** Rows of the injected "本轮每题用时" card, read out of its Shadow DOM. */
function summaryRowCount(): number {
  return (
    document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelectorAll('tbody tr').length ?? 0
  );
}

function summaryText(): string {
  return document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.textContent ?? '';
}

/**
 * The state the extension mirrors onto the page for support/verification:
 * `#khan-academy-timer-host[data-khan-timer-diagnostics]`. It is readable even
 * while the panel itself is hidden, which is what makes 识别：未识别 checkable
 * in a real browser.
 */
function diagnostics(): Record<string, unknown> {
  const raw = overlayHost()?.getAttribute('data-khan-timer-diagnostics');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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

/* ------------------------------------------------------------------ *
 * 识别：未识别 — the page offers no usable question identity
 * ------------------------------------------------------------------ */

describe('a question that cannot be identified', () => {
  it('hides the panel, freezes the clock and resumes the same question from the frozen value', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5200);

    expect(panelVisible()).toBe(true);
    expect(displayedMs()).toBeGreaterThanOrEqual(4000);

    // The question area disappears while the SPA swaps content: the page now
    // has no usable identity, which the panel calls 识别：未识别.
    setPage(interimDom({ index: 0, total: 4 }));
    await advance(1500);

    // No panel, and the question's clock is frozen rather than still running.
    expect(panelVisible()).toBe(false);
    const frozen = savedSession(data, EXERCISE_A);
    expect(frozen['phase']).toBe('paused');
    const frozenMs = frozen['accumulatedMs'] as number;
    expect(frozenMs).toBeGreaterThanOrEqual(4000);
    expect(frozenMs).toBeLessThan(8000);
    // The same state is mirrored onto the page, so it can be checked from the
    // browser console even though the panel is hidden.
    expect(diagnostics()).toMatchObject({
      unidentified: true,
      autoPausedForIdentity: true,
      enginePhase: 'paused',
    });

    // 30 s with nothing identifiable: still no panel, and none of that time is
    // billed to the question.
    await advance(30_000);
    expect(panelVisible()).toBe(false);
    expect(savedSession(data, EXERCISE_A)['accumulatedMs']).toBeLessThan(8000);

    // The SAME question becomes identifiable again: the clock carries on from
    // the value it was paused at instead of restarting at zero.
    setPage(exerciseDom({ index: 0, total: 4 }));
    await advance(1500);

    expect(panelVisible()).toBe(true);
    const resumed = savedSession(data, EXERCISE_A);
    expect(resumed['phase']).toBe('running');
    expect(resumed['accumulatedMs']).toBeGreaterThanOrEqual(4000);
    expect(resumed['accumulatedMs']).toBeLessThan(9000);
    // The unidentified stretch is reported as paused time, and the learner
    // never pressed 暂停.
    expect(resumed['pausedMs']).toBeGreaterThanOrEqual(30_000);
    expect(displayedMs()).toBeGreaterThanOrEqual(4000);
    expect(displayedMs()).toBeLessThan(12_000);
    expect(diagnostics()).toMatchObject({
      unidentified: false,
      autoPausedForIdentity: false,
      enginePhase: 'running',
    });
  });

  it('never undoes a pause the learner asked for', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);

    // The learner pauses from the panel.
    clickOverlay('pause');
    await advance(500);
    expect(pauseLabel()).toBe('继续');

    // The page then loses its identity and comes back. Only an *automatic*
    // pause is resumed, so this one must stay paused.
    setPage(interimDom({ index: 0, total: 4 }));
    await advance(1000);
    expect(panelVisible()).toBe(false);

    setPage(exerciseDom({ index: 0, total: 4 }));
    await advance(1500);

    expect(panelVisible()).toBe(true);
    expect(pauseLabel()).toBe('继续');
    expect(savedSession(data, EXERCISE_A)['phase']).toBe('paused');
  });

  it('keeps a question paused mid-way in the end-of-exercise summary', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 3 }));
    controller = new ContentController();
    await controller.init();

    // Question 1: answered correctly, then the page advances.
    await advance(5000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(2500);

    // Question 2: answered for a while, then the page cannot be identified for
    // 20 s, then the SAME question comes back and is finished.
    await advance(4000);
    setPage(interimDom({ index: 1, total: 3 }));
    await advance(1000);
    expect(panelVisible()).toBe(false);
    await advance(20_000);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(1500);
    expect(panelVisible()).toBe(true);
    await advance(2000);
    answerCorrectly(1);
    await advance(300);

    // Question 3, then the end-of-exercise screen.
    setPage(exerciseDom({ index: 2, total: 3, stem: 'Add. 999+1' }));
    await advance(2500);
    await advance(2000);
    answerCorrectly(2);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);

    // Every question of the run is on the summary — including the one whose
    // clock was paused half-way through.
    const records = savedRecords(data);
    expect(records).toHaveLength(3);
    const paused = records[1] ?? {};
    expect(paused['questionKey']).toBe('id:progress:2 of 3');
    // The 20 s of 未识别 are excluded from the question's time ...
    expect(paused['durationMs']).toBeGreaterThan(4000);
    expect(paused['durationMs']).toBeLessThan(15_000);
    // ... and reported separately as paused time.
    expect(paused['pausedMs']).toBeGreaterThanOrEqual(20_000);
    // An automatic pause must not claim the learner pressed 暂停.
    expect(paused['wasPaused']).toBe(false);
    expect(paused['firstSubmissionOutcome']).toBe('correct');

    expect(summaryRowCount()).toBe(3);
    // Rows follow capture order, so row 2 is the question that was paused.
    expect(summaryText()).toContain('第 2 题');
    expect(summaryText()).toContain('暂停 0:2');
    expect(summaryText()).not.toContain('加试');
  });

  it('matches the manual verification recipe in the README (remove then restore the region)', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);

    expect(diagnostics()).toMatchObject({
      unidentified: false,
      autoPausedForIdentity: false,
      enginePhase: 'running',
    });

    // --- README → 手动验证「识别：未识别 → 暂停 → 恢复」第 2 步 ---
    const removed: Array<[Node, Element, Node | null]> = [
      ...document.querySelectorAll(
        'form[name="answerform"], .framework-perseus, .perseus-renderer',
      ),
    ].map((el) => [el.parentNode as Node, el, el.nextSibling]);
    removed.forEach(([, el]) => el.remove());
    await advance(1500);

    expect(panelVisible()).toBe(false);
    expect(diagnostics()).toMatchObject({
      unidentified: true,
      autoPausedForIdentity: true,
      enginePhase: 'paused',
    });

    // --- README → 手动验证 第 3 步：原样放回 ---
    [...removed].reverse().forEach(([parent, el, next]) => parent.insertBefore(el, next));
    await advance(1500);

    expect(panelVisible()).toBe(true);
    expect(diagnostics()).toMatchObject({
      unidentified: false,
      autoPausedForIdentity: false,
      enginePhase: 'running',
    });
    // The clock carried on from where it was frozen instead of restarting.
    const session = savedSession(data, EXERCISE_A);
    expect(session['phase']).toBe('running');
    expect(session['accumulatedMs']).toBeGreaterThanOrEqual(3000);
    expect(session['pausedMs']).toBeGreaterThanOrEqual(500);
  });
});

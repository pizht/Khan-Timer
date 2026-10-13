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
import { formatDuration } from '../src/timer-engine.js';
import { t } from '../src/i18n/index.js';

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
 * The Perseus question region on its own, with NO progress marker.
 *
 * The intro card of a not-yet-started practice contains exactly this much of a
 * question (measured live): the framework and the renderer are in the DOM
 * before the exercise footer that holds `exercise-progress-*`. It carries no
 * position, so it is not a question being solved.
 */
function questionRegionDom({ stem = 'Add. 608+251' } = {}): string {
  return `
    <div class="framework-perseus">
      <form name="answerform">
        <div class="perseus-renderer perseus-renderer-responsive">
          <div data-perseus-paragraph-index="0">${stem}</div>
          <div class="perseus-widget-container widget-inline-block">
            <input type="text" class="perseus-input" />
          </div>
        </div>
      </form>
    </div>`;
}

/** The intro card as the real page renders it: still holding that leftover region. */
function startCardWithLeftoverRegionDom(): string {
  return `
    <div class="bibliotron-exercise">
      <div data-testid="start-task-card-summary">
        <h2>Ready to practice?</h2>
        <button>Let\u2019s go</button>
      </div>
      ${questionRegionDom()}
    </div>`;
}

/**
 * The exercise chrome with the question area momentarily gone — what the page
 * looks like while the SPA swaps a question, and the state the panel labels
 * "Detection: unidentified".
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

/**
 * The state a real page starts in: the question region is rendered before the
 * exercise footer's progress marker is, so the extension's first identity for
 * the question is a fingerprint (measured on khanacademy.org).
 */
function loadingDom({ stem = 'Add. 608+251' } = {}): string {
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
        <div class="progress" data-progress-slot="1"></div>
        <button data-testid="exercise-check-answer">Check</button>
      </div>
    </div>`;
}

/** The progress marker finally renders, as it does a second into a page load. */
function renderProgress(index: number, total: number): void {
  const slot = document.querySelector('[data-progress-slot]');
  if (slot) slot.innerHTML = progressCells(index, total, 'incomplete');
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

/** The panel's own Pause/Resume control, as the learner sees its label. */
function pauseLabel(): string {
  return (
    overlayHost()?.shadowRoot?.querySelector('[data-role="pause"]')?.textContent?.trim() ?? ''
  );
}

/**
 * The warning line of the panel, as the learner sees it: the text when it is on
 * screen, an empty string when the element is present but hidden.
 */
function panelWarning(): string {
  const warning = overlayHost()?.shadowRoot?.querySelector('[data-role="warning"]') as
    | HTMLElement
    | null
    | undefined;
  if (!warning) return '';
  return warning.hidden ? '' : (warning.textContent ?? '');
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

/**
 * The state the real page leaves an answered question in [OBS]: the Check button
 * is gone and the advance control has taken its place, so the question reads as
 * "finished" while it is still the one on screen. That is the state the learner
 * sits in between answering and clicking "Next question" - and the state a tab
 * switch, a reload or a detour through another page happens in.
 */
function replaceCheckWithAdvance(): void {
  const check = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!check) throw new Error('the page has no Check button to replace');
  const next = document.createElement('button');
  next.setAttribute('data-testid', 'exercise-next-question');
  next.textContent = 'Next question';
  check.replaceWith(next);
}

/**
 * What the learner does to the page when they leave it: the tab goes to the
 * background (visibilitychange) and the page is hidden (pagehide). Both are
 * wired to the same flush, and a reload fires both as well.
 */
function leaveThePage(): void {
  window.dispatchEvent(new Event('pagehide'));
}

/** Answer question `index`, as the page renders it afterwards. */
async function answerAndReplaceControls(index: number): Promise<void> {
  answerCorrectly(index);
  replaceCheckWithAdvance();
  await advance(1000);
}

/** Rows of the injected "Time per question in this attempt" card, read out of its
 * Shadow DOM. */
function summaryRowCount(): number {
  return (
    document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelectorAll('tbody tr').length ?? 0
  );
}

function summaryText(): string {
  return document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.textContent ?? '';
}

/**
 * A row label with every tag word removed, so "which question is this row about"
 * can be asserted without depending on how the tags happen to be worded.
 */
function stripRowTags(label: string): string {
  const tags = [
    t('summary.tagCorrect'),
    t('summary.tagIncorrect'),
    t('summary.tagTimedOut'),
    t('summary.tagSkipped'),
    t('summary.tagBonus'),
    t('summary.tagMissing'),
  ];
  return tags.reduce((text, tag) => text.split(tag).join(''), label).trim();
}

/**
 * Matcher for the card's header line — "3 questions · 2 with data · 0:42 total".
 *
 * The summed time is deliberately left open: these tests drive fake timers, and
 * what is being asserted is the question COUNT. Everything else, wording and
 * plural form included, comes from the catalog, which keeps the assertion
 * language-agnostic.
 */
function totalLine(count: number, timed?: number): RegExp {
  const marker = '\u0000';
  const template =
    timed === undefined
      ? t('summary.totalAll', { count, total: marker })
      : t('summary.totalPartial', { count, timed, total: marker });
  const [head = '', tail = ''] = template.split(marker);
  return new RegExp(`${escapeRegExp(head)}.+${escapeRegExp(tail)}`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The label and duration cell of each row of the summary card, in order. */
function summaryRows(): Array<{ label: string; duration: string }> {
  const rows =
    document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelectorAll('tbody tr') ?? [];
  return Array.from(rows).map((row) => ({
    label: row.querySelector('td.num')?.textContent?.trim() ?? '',
    duration: row.querySelector('td.dur')?.textContent?.trim() ?? '',
  }));
}

/**
 * The state the extension mirrors onto the page for support/verification:
 * `#khan-academy-timer-host[data-khan-timer-diagnostics]`. It is readable even
 * while the panel itself is hidden, which is what makes the unidentified state
 * checkable in a real browser.
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
 * "Detection: unidentified" — the page offers no usable question identity
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
    // has no usable identity, which the panel calls "Detection: unidentified".
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
    // never pressed Pause.
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
    expect(pauseLabel()).toBe(t('overlay.resume'));

    // The page then loses its identity and comes back. Only an *automatic*
    // pause is resumed, so this one must stay paused.
    setPage(interimDom({ index: 0, total: 4 }));
    await advance(1000);
    expect(panelVisible()).toBe(false);

    setPage(exerciseDom({ index: 0, total: 4 }));
    await advance(1500);

    expect(panelVisible()).toBe(true);
    expect(pauseLabel()).toBe(t('overlay.resume'));
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
    // The 20 s of unidentified time are excluded from the question's time ...
    expect(paused['durationMs']).toBeGreaterThan(4000);
    expect(paused['durationMs']).toBeLessThan(15_000);
    // ... and reported separately as paused time.
    expect(paused['pausedMs']).toBeGreaterThanOrEqual(20_000);
    // An automatic pause must not claim the learner pressed Pause.
    expect(paused['wasPaused']).toBe(false);
    expect(paused['firstSubmissionOutcome']).toBe('correct');

    expect(summaryRowCount()).toBe(3);
    // Rows follow capture order, so row 2 is the question that was paused.
    expect(summaryText()).toContain(t('summary.questionNumber', { number: 2 }));
    expect(summaryText()).toContain(t('summary.paused', { duration: '0:2' }));
    expect(summaryText()).not.toContain(t('summary.tagBonus'));
  });

  it('pauses instead of resetting when the question region disappears and comes back', async () => {
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

    // --- step 2 of "unidentified → paused → resumed": the region disappears ---
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

    // --- step 3: put the region back unchanged ---
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

  /**
   * The reported bug (user report, translated): "Why does the timer panel show
   * 'Cannot reliably identify the current question (question region not found)'?"
   *
   * A gap of a few hundred milliseconds - the SPA replacing the question subtree
   * while it re-renders - emitted `uncertain`, which froze the clock and wrote
   * the warning. Identity came back an instant later and the clock resumed, but
   * the warning was never cleared, so it stayed on screen next to a running
   * clock and a perfectly readable question until the next question change.
   */
  it('does not keep the not-found warning after the same question is identified again', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5200);

    expect(panelVisible()).toBe(true);
    expect(panelWarning()).toBe('');

    // A gap of one poll interval: the question area is gone, then back, with
    // the SAME identity (progress index 1 of 4).
    setPage(interimDom({ index: 0, total: 4 }));
    await advance(400);
    expect(panelVisible()).toBe(false);

    setPage(exerciseDom({ index: 0, total: 4 }));
    await advance(1500);

    // Panel back, clock running again, same question ...
    expect(panelVisible()).toBe(true);
    expect(diagnostics()).toMatchObject({
      unidentified: false,
      autoPausedForIdentity: false,
      enginePhase: 'running',
    });
    // ... so the warning that described the gap must be gone with it.
    expect(panelWarning()).toBe('');
    expect(savedSession(data, EXERCISE_A)['phase']).toBe('running');
  });

  it('keeps the warning only while the page really cannot describe a question', async () => {
    installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);

    setPage(interimDom({ index: 0, total: 4 }));
    await advance(1000);

    // Hidden panel: the warning is not rendered at all (it would describe a
    // state the learner cannot see, and would outlive it).
    expect(panelVisible()).toBe(false);
    expect(panelWarning()).toBe('');
  });
});

/* ================================================================== *
 * The card of the practice the learner came back to
 * ================================================================== */

/**
 * The requirement these tests lock in: after switching to another practice and
 * coming back, finishing the remaining questions produces a card for the
 * ORIGINAL practice that still lists the questions timed before the switch -
 * numbered by the question they are about, in question order, with a
 * "No data" row for a number that has no data instead of the next question's
 * time sliding up into its place.
 *
 * Real DOM, real detector, real coordinator, real storage shape (in memory),
 * read back through the injected card's Shadow DOM as a learner would see it.
 */
describe('the card of a practice resumed after a switch', () => {
  it('still lists the questions timed before the switch, in question order', async () => {
    const { data } = installChromeStorage();

    // --- Practice A: question 1 of 3, answered, then the page advances ------
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 3 }));
    controller = new ContentController();
    await controller.init();
    await advance(4000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(1500);
    expect(savedRecords(data)).toHaveLength(1);

    // ... and question 2 is being answered when the learner leaves.
    await advance(3000);

    // --- Switch to practice B, which shows its "Ready to practice?" card ----
    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardDom());
    await advance(1000);
    expect(panelVisible()).toBe(false);

    // Practice B gets its own run and its own record.
    setPage(exerciseDom({ index: 0, total: 2, stem: 'Subtract. 400-251' }));
    await advance(3000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 2, stem: 'Subtract. 500-251' }));
    await advance(1500);
    expect(savedRecords(data)).toHaveLength(2);

    // --- Back to practice A, on the same question it was left on ------------
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(2000);
    expect(panelVisible()).toBe(true);
    // The clock resumed from the parked value, so the ~4 s from before the
    // switch are still on it (it would read ~2 s if the session had been lost).
    expect(displayedMs()).toBeGreaterThanOrEqual(4000);
    // And the time spent in practice B was never billed to it.
    expect(displayedMs()).toBeLessThan(9000);

    // Question 2 is finished, then question 3, then the end-of-exercise screen.
    answerCorrectly(1);
    await advance(300);
    setPage(exerciseDom({ index: 2, total: 3, stem: 'Add. 999+1' }));
    await advance(2500);
    answerCorrectly(2);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);

    // --- What is stored: both practices kept their own run ------------------
    const records = savedRecords(data);
    expect(records).toHaveLength(4);
    const aRecords = records.filter((record) => record['exerciseKey'] === EXERCISE_A);
    const bRecords = records.filter((record) => record['exerciseKey'] === EXERCISE_B);
    expect(aRecords).toHaveLength(3);
    expect(bRecords).toHaveLength(1);
    const runIds = new Set(aRecords.map((record) => record['runId']));
    expect(runIds.size).toBe(1);
    expect(runIds.has('')).toBe(false);
    expect(bRecords[0]?.['runId']).not.toBe([...runIds][0]);

    // The question answered BEFORE the switch survived with its own duration,
    // not inflated by the detour through practice B.
    expect(Number(aRecords[0]?.['durationMs'])).toBeGreaterThanOrEqual(3500);
    expect(Number(aRecords[0]?.['durationMs'])).toBeLessThan(12_000);
    // The question that was interrupted mid-way kept the time from before the
    // switch and added the time after it.
    expect(Number(aRecords[1]?.['durationMs'])).toBeGreaterThanOrEqual(5000);

    // --- What the learner sees: practice A's card, and only practice A's ----
    expect(summaryRowCount()).toBe(3);
    const rows = summaryRows();
    expect(rows.map((row) => stripRowTags(row.label))).toEqual(
      [1, 2, 3].map((number) => t('summary.questionNumber', { number })),
    );
    // Row 1 is the question from before the switch, showing its real duration.
    expect(rows[0]?.label).toContain(t('summary.tagCorrect'));
    expect(rows[0]?.duration).toBe(formatDuration(Number(aRecords[0]?.['durationMs'])));
    expect(summaryText()).not.toContain(t('summary.questionNumber', { number: 4 }));
    expect(summaryText()).toMatch(totalLine(3));
  });

  it('stamps the number of the question it timed, not the one the page moved on to', async () => {
    const { data } = installChromeStorage();

    // Practice A, question 2 of 3: the record captured for it must carry "2",
    // even though the progress marker already reads "3 of 3" by the time the
    // change is processed.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 1, total: 3 }));
    controller = new ContentController();
    await controller.init();
    await advance(4000);

    // The learner submits a WRONG answer (the clock keeps running) and then the
    // page advances: this question ends without a held record.
    document
      .querySelector('[data-testid="exercise-check-answer"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document
      .querySelector('[data-testid="exercise-progress-1-incomplete-current"]')
      ?.setAttribute('data-testid', 'exercise-progress-1-incorrect-current');
    await advance(1000);

    setPage(exerciseDom({ index: 2, total: 3, stem: 'Add. 999+1' }));
    await advance(2500);

    const records = savedRecords(data);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      questionKey: 'id:progress:2 of 3',
      questionIndex: 1,
      questionTotal: 3,
      firstSubmissionOutcome: 'incorrect',
    });
  });

  it('keeps a numbered gap open instead of sliding the next question up', async () => {
    const { data } = installChromeStorage();

    // Practice A: question 1 answered, then the learner leaves for practice B.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 3 }));
    controller = new ContentController();
    await controller.init();
    await advance(4000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(1500);

    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardDom());
    await advance(1000);

    // Back on practice A the page is on question 3: question 2 was never timed
    // by the extension (the learner was away while the exercise moved on).
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 2, total: 3, stem: 'Add. 999+1' }));
    await advance(3000);
    answerCorrectly(2);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);

    const aRecords = savedRecords(data).filter((record) => record['exerciseKey'] === EXERCISE_A);
    expect(aRecords.map((record) => record['questionIndex'])).toEqual([0, 2]);

    // Three questions, numbered by the question each row is about: question 2
    // says "No data" rather than showing question 3's time under its number.
    expect(summaryRowCount()).toBe(3);
    const rows = summaryRows();
    expect(rows[0]?.label).toContain(t('summary.questionNumber', { number: 1 }));
    expect(rows[0]?.duration).toBe(formatDuration(Number(aRecords[0]?.['durationMs'])));
    expect(rows[1]?.label).toContain(t('summary.questionNumber', { number: 2 }));
    expect(rows[1]?.label).toContain(t('summary.tagMissing'));
    expect(rows[1]?.duration).toBe('—');
    expect(rows[2]?.label).toContain(t('summary.questionNumber', { number: 3 }));
    expect(rows[2]?.duration).toBe(formatDuration(Number(aRecords[1]?.['durationMs'])));
    // The header says how many of the attempt's questions actually have data.
    expect(summaryText()).toMatch(totalLine(3, 2));
  });
});

/* ================================================================== *
 * The identity upgrade on a real page load (measured live)
 * ================================================================== */

/**
 * A real page load has the question region (about 1.3 s) before the footer's
 * progress marker (about 1.5 s), so the extension sees a fingerprint - "content
 * that looks like a question" - before the page can say WHICH question it is.
 *
 * Measured on khanacademy.org that gap is 20-200 ms, and a practice's start card
 * can hold the previous question's region for much longer. The clock therefore
 * starts at the POSITION, not at the region: the page-load stretch (and any
 * start-card stretch) is never billed to the first question, and never shows up
 * in the summary as a mysterious "Paused 0:01" (see the report this pins down).
 */
describe('a question region that carries no position yet', () => {
  it('does not start the clock until the page says which question it is', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(loadingDom());
    controller = new ContentController();
    await controller.init();
    await advance(4000);

    // Four seconds with a fingerprint only: no clock, no panel, no session, and
    // therefore nothing that could end up as paused time on question 1.
    expect(panelVisible()).toBe(false);
    expect(data[sessionKey(EXERCISE_A)]).toBeUndefined();
    expect(savedRecords(data)).toHaveLength(0);

    renderProgress(0, 4);
    await advance(2000);

    // The clock starts here, from zero - the four seconds above belong to no
    // question, so they are not counted (and not reported as a pause). Counting
    // them would put ~6 s on a 2 s advance; the detector needs a tick to notice
    // the marker, so the reading is never more than a tick short of the advance.
    expect(panelVisible()).toBe(true);
    expect(displayedMs()).toBeGreaterThanOrEqual(500);
    expect(displayedMs()).toBeLessThan(3000);
    expect(savedRecords(data)).toHaveLength(0);

    const session = savedSession(data, EXERCISE_A);
    expect(session['questionKey']).toBe('id:progress:1 of 4');
    expect(session['pausedMs']).toBe(0);
    expect(typeof session['stemFingerprint']).toBe('string');
  });

  it('resumes the accumulated time across a reload, without billing the load', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(loadingDom());
    controller = new ContentController();
    await controller.init();
    // The marker renders; the detector notices it on the next tick. Six seconds
    // so the running session crosses its periodic checkpoint (every 5 s while
    // running, spec 5.3: never once per DOM mutation).
    renderProgress(0, 4);
    await advance(6000);

    const parked = savedSession(data, EXERCISE_A);
    const parkedStem = parked['stemFingerprint'];
    // The stored value is the time THIS question was timed for, and nothing from
    // the page load: six seconds minus at most one detector tick.
    const parkedMs = parked['accumulatedMs'] as number;
    expect(parkedMs).toBeGreaterThanOrEqual(3000);
    expect(parkedMs).toBeLessThan(6500);
    expect(parked['pausedMs']).toBe(0);

    // Reload the page: the document starts fingerprint-only again, and closing
    // it flushes the session exactly as a real unload does.
    window.dispatchEvent(new Event('pagehide'));
    controller.dispose();
    controller = null;
    const beforeReload = savedSession(data, EXERCISE_A)['accumulatedMs'] as number;
    setPage(loadingDom());
    controller = new ContentController();
    await controller.init();
    await advance(1500);

    // Still no question: nothing is timed, nothing is shown, and the stored
    // session is untouched (it is not overwritten by a fingerprint phase).
    expect(panelVisible()).toBe(false);
    expect(savedSession(data, EXERCISE_A)['accumulatedMs']).toBe(beforeReload);

    // The marker arrives: the same question resumes from the stored value, so
    // the interruption cost nothing, and the page load is not added to it -
    // which is also what keeps a "Paused 0:0x" row out of the summary.
    renderProgress(0, 4);
    await advance(1500);
    expect(panelVisible()).toBe(true);
    const resumedMs = savedSession(data, EXERCISE_A)['accumulatedMs'] as number;
    expect(resumedMs).toBeGreaterThanOrEqual(beforeReload);
    expect(resumedMs).toBeLessThan(beforeReload + 6000);
    expect(savedSession(data, EXERCISE_A)['pausedMs']).toBe(0);
    expect(savedSession(data, EXERCISE_A)['stemFingerprint']).toBe(parkedStem);
  });
});

/* ================================================================== *
 * The frame between two practices (measured live)
 * ================================================================== */

describe('moving to another practice inside the app', () => {
  it('does not mistake the torn-down frame for the end of the exercise', async () => {
    const { data } = installChromeStorage();

    // Practice A: question 1 of 3 answered, then the page advances to question 2.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 3 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(2500);

    const beforeSwitch = savedRecords(data);
    expect(beforeSwitch).toHaveLength(1);
    const firstRunId = beforeSwitch[0]?.['runId'];
    expect(firstRunId).toBeTruthy();

    // In-app move to practice B. For a moment the old exercise is gone (no
    // answer form, no progress markers, exercise chrome still up) while the URL
    // already points at B - structurally identical to the summary screen.
    window.history.pushState({}, '', EXERCISE_B);
    setPage('<div class="bibliotron-exercise"></div>');
    await advance(2000);
    expect(summaryRowCount()).toBe(0);

    // Practice B renders its first question, one is done there, and B advances
    // (which is what writes B's held record).
    setPage(exerciseDom({ index: 0, total: 2, stem: 'Subtract. 400-251' }));
    await advance(2500);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 2, stem: 'Subtract. 500-251' }));
    await advance(2000);
    expect(savedRecords(data)).toHaveLength(2);

    // Back to practice A, on the question it was left on.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 1, total: 3, stem: 'Add. 251+608' }));
    await advance(2500);
    answerCorrectly(1);
    await advance(300);
    setPage(exerciseDom({ index: 2, total: 3, stem: 'Add. 999+1' }));
    await advance(2500);
    answerCorrectly(2);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);

    // Practice A is still ONE attempt: the record written before the switch and
    // the ones written after it belong to the same run, so the card lists all
    // three questions instead of only the ones from after the switch.
    const aRecords = savedRecords(data).filter((record) => record['exerciseKey'] === EXERCISE_A);
    expect(aRecords).toHaveLength(3);
    expect(new Set(aRecords.map((record) => record['runId']))).toEqual(new Set([firstRunId]));
    expect(summaryRowCount()).toBe(3);
    expect(summaryText()).not.toContain(t('summary.tagMissing'));
  });
});

/* ================================================================== *
 * The earlier questions are found again after the attempt id is lost
 * ================================================================== */

describe('a card built when the attempt id was lost mid-way', () => {
  it('still lists the questions timed before the switch', async () => {
    const { data } = installChromeStorage();

    // Practice A: two questions done (records under the first attempt id).
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 4, stem: 'Add. 251+608' }));
    await advance(2500);
    answerCorrectly(1);
    await advance(300);
    setPage(exerciseDom({ index: 2, total: 4, stem: 'Add. 999+1' }));
    await advance(2500);
    expect(savedRecords(data)).toHaveLength(2);

    // The attempt id is lost while the learner is away (this is what a spurious
    // summary used to do), and a new one starts when they come back.
    data[sessionKey(EXERCISE_A)] = undefined;
    delete data['run:' + EXERCISE_A];
    controller.dispose();
    controller = new ContentController();
    await controller.init();
    await advance(2500);

    // Finish the remaining questions and reach the summary.
    answerCorrectly(2);
    await advance(300);
    setPage(exerciseDom({ index: 3, total: 4, stem: 'Add. 111+222' }));
    await advance(2500);
    answerCorrectly(3);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);

    // Four questions, all four with data - the two from before the interruption
    // are retrieved by practice + attempt window, not by the lost run id.
    expect(summaryRowCount()).toBe(4);
    expect(summaryText()).not.toContain(t('summary.tagMissing'));
    const aRecords = savedRecords(data).filter((record) => record['exerciseKey'] === EXERCISE_A);
    expect(aRecords).toHaveLength(4);
    expect(new Set(aRecords.map((record) => record['runId'])).size).toBe(2);
  });
});

/* ================================================================== *
 * The card must only ever appear on a real summary screen
 * ================================================================== */

describe('the card is bound to the end-of-exercise screen', () => {
  it('does not appear on a page that merely has no question on it', async () => {
    const { data } = installChromeStorage();

    // Practice A with a question being timed (nothing answered yet, so no
    // question is finished).
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(4000);
    expect(panelVisible()).toBe(true);

    // The page loses its question for a moment (an in-app transition, or the
    // "Ready to practice?" screen being re-rendered) while the URL stays on
    // practice A and the current attempt is still known. Structurally this is
    // "no answer form, no progress markers, exercise chrome present" - the old
    // summary test in full - but no question was ever finished here.
    setPage('<div class="bibliotron-exercise"></div>');
    await advance(3000);
    expect(summaryRowCount()).toBe(0);
    expect(document.getElementById(SUMMARY_HOST_ID)).toBeNull();

    // ... and when the intro card renders, the card is still not there.
    setPage(startCardDom());
    await advance(2500);
    expect(summaryRowCount()).toBe(0);
    expect(document.getElementById(SUMMARY_HOST_ID)).toBeNull();
  });

  it('is removed if the intro card comes up while it is on screen', async () => {
    const { data } = installChromeStorage();

    // A complete little run: one question, answered, then the summary.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 1 }));
    controller = new ContentController();
    await controller.init();
    await advance(3000);
    answerCorrectly(0);
    await advance(300);
    setPage(summaryDom());
    await advance(2500);
    expect(summaryRowCount()).toBe(1);

    // The learner starts the exercise again: the intro card replaces the summary
    // (no question form yet, URL unchanged). The card must not stay on top of it.
    setPage(startCardDom());
    await advance(2500);
    expect(document.getElementById(SUMMARY_HOST_ID)).toBeNull();
    expect(summaryRowCount()).toBe(0);
  });
});

/* ================================================================== *
 * The panel must only appear over a question that is being solved
 * ================================================================== */

/**
 * The reported bug:
 *
 *   "Opening a practice start card shows the timer panel, then closes it at once."
 *
 * Opening a practice's start card showed the floating panel for a moment and
 * then took it away again. Two causes, both covered here:
 *
 *  1. the panel was in the DOM *visible by default*: the overlay host was
 *     appended without a display and only hidden once the controller rendered,
 *     so it was on screen for the stretch between mounting and the first
 *     detection result;
 *  2. an engine was created from a leftover question region — the Perseus
 *     framework is in the DOM before the exercise footer's progress marker is —
 *     so the panel had something to show, and only disappeared once the page
 *     finished tearing the old question down.
 *
 * The rule these tests lock in: the panel appears only over a question the page
 * has actually confirmed is being solved, and it is never on screen before that
 * confirmation arrives.
 */
describe('the panel appears only over a question being solved', () => {
  it('is not on screen at any point while a practice start card is up', async () => {
    installChromeStorage();

    // The learner arrives at the practice route. The start card is up, but the
    // Perseus framework of the previous question has not been torn down yet -
    // exactly the state that used to flash the panel and then close it.
    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardWithLeftoverRegionDom());
    controller = new ContentController();
    await controller.init();

    // The overlay is in the DOM but is born hidden, and stays hidden.
    expect(overlayHost()).not.toBeNull();
    expect(overlayHost()?.style.display).toBe('none');

    await advance(4000);
    expect(panelVisible()).toBe(false);
    expect(document.getElementById(SUMMARY_HOST_ID)).toBeNull();
    // ... and it stays off once the page clears the leftover region too.
    setPage(startCardDom());
    await advance(2000);
    expect(panelVisible()).toBe(false);
  });

  it('does not show the previous practice clock when the learner switches to another practice', async () => {
    const { data } = installChromeStorage();

    // Practice A: a question is being timed.
    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 1, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);
    expect(panelVisible()).toBe(true);

    // The learner switches to practice B, whose start card comes up while the
    // old question region is still in the DOM.
    window.history.pushState({}, '', EXERCISE_B);
    setPage(startCardWithLeftoverRegionDom());
    // Practice A's clock is not painted on it: the panel is taken down as soon
    // as the page stops being practice A, not when the leftover region is
    // finally cleared (which is what used to make the panel appear and then
    // close by itself).
    await advance(300);
    expect(panelVisible()).toBe(false);
    await advance(1500);
    expect(panelVisible()).toBe(false);

    // Practice A's time survived the switch, as it must.
    expect(savedSession(data, EXERCISE_A)['accumulatedMs']).toBeGreaterThanOrEqual(4000);

    // Practice B's own question appears: the panel comes up on it.
    setPage(exerciseDom({ index: 0, total: 2, stem: 'Subtract. 400-251' }));
    await advance(2000);
    expect(panelVisible()).toBe(true);
  });

  it('comes up as soon as the page confirms a question is being solved', async () => {
    installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(1000);

    expect(panelVisible()).toBe(true);
    expect(diagnostics()).toMatchObject({ unidentified: false, enginePhase: 'running' });
  });

  it('comes up when the learner starts the exercise from the intro card, and question 1 keeps none of the intro time', async () => {
    const { data } = installChromeStorage();

    // The start card is up, with the leftover question region that carries no
    // position - the state the report describes ("Not started yet" but content that
    // looks like a question). It stays up for a good while, as it does when the
    // learner reads it before pressing "Let's go".
    window.history.pushState({}, '', EXERCISE_A);
    setPage(startCardWithLeftoverRegionDom());
    controller = new ContentController();
    await controller.init();
    await advance(30_000);
    expect(panelVisible()).toBe(false);
    // No clock, no session: nothing at all is being timed yet.
    expect(data[sessionKey(EXERCISE_A)]).toBeUndefined();

    // The learner presses "Let's go": the card goes, question 1 renders together
    // with the progress marker. That is the confirmation both the panel and the
    // clock wait for.
    setPage(exerciseDom({ index: 0, total: 4 }));
    await advance(2000);

    expect(panelVisible()).toBe(true);
    expect(diagnostics()).toMatchObject({
      engineQuestionKey: 'id:progress:1 of 4',
      enginePhase: 'running',
    });
    // Question 1 carries the time spent SOLVING it - the 30 s of intro card are
    // not on it, and nothing was ever auto-paused, so its record will not show
    // the "Paused 0:01" that this report was about.
    const session = savedSession(data, EXERCISE_A);
    expect(session['pausedMs']).toBe(0);
    expect(session['accumulatedMs']).toBeLessThan(3000);

    // Answer it correctly and let the page advance, so the record is written.
    answerCorrectly(0);
    await advance(300);
    setPage(exerciseDom({ index: 1, total: 4, stem: 'Add. 251+608' }));
    await advance(1500);

    const records = savedRecords(data);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      questionIndex: 0,
      endReason: 'answered-correct',
      wasPaused: false,
    });
    expect(records[0]?.['pausedMs']).toBe(0);
    expect(Number(records[0]?.['durationMs'])).toBeLessThan(8000);
  });
});

/* ================================================================== *
 * Leaving the page must not lose the last answer
 * ================================================================== */

/**
 * The learner answers a question and closes the tab (or reloads, or walks to
 * another page) before the next question renders.
 *
 * The record for a finished question is deliberately held back until the
 * question actually changes, so the end-of-exercise card can include it. If the
 * learner leaves first, nothing else will ever finalise it - so the unload hook
 * has to write it, exactly as it already writes the resumable session.
 */
describe('closing the page right after answering', () => {
  it('still stores the answer, with its time and no spurious pause', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);

    // Answer it correctly: the clock stops and the record is held.
    answerCorrectly(0);
    await advance(1000);
    expect(savedRecords(data)).toHaveLength(0);
    expect(savedSession(data, EXERCISE_A)['phase']).toBe('finished');

    // The learner closes the tab instead of advancing.
    window.dispatchEvent(new Event('pagehide'));
    await advance(1000);

    const records = savedRecords(data);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      exerciseKey: EXERCISE_A,
      questionKey: 'id:progress:1 of 4',
      questionIndex: 0,
      endReason: 'answered-correct',
      wasPaused: false,
    });
    // The time it was solved for, and nothing paused: the page-load stretch was
    // never timed, so there is no "Paused 0:01" on the first question.
    expect(records[0]?.['pausedMs']).toBe(0);
    expect(Number(records[0]?.['durationMs'])).toBeGreaterThanOrEqual(4000);
  });
});

/* ================================================================== *
 * One question is one record (reported bug, measured in a real profile)
 * ================================================================== */

/**
 * The bug this block encodes. A practice of 4 questions plus the optional bonus
 * question produced a card with ELEVEN rows - questions 1-4 and seven "Bonus"
 * rows - on which question 1 read 12:58 for a question that took 1:51.
 *
 * The stored records showed why: one and the same stretch of a question (same
 * questionKey, same startedAt, same durationMs - a new id and a new endedAt each
 * time) had been written to storage up to seven times. The card adds records of
 * the same question number together by design (two visits to a question are two
 * stretches), so the copies inflated question 1 to 7 x 1:51 = 12:58; and every
 * copy of the bonus question - which is placed by its own index, not by its
 * number - became a row of its own.
 *
 * Where the copies came from: an answered question keeps its record HELD while
 * it is still on screen, so the card can include the last question of the
 * exercise. Writing that record out when the learner leaves the page is
 * deliberate - closing the tab right after answering must not be lossy - but it
 * left nothing behind that said "this question has already been recorded", and
 * the answered question stays on screen until the learner clicks "Next
 * question":
 *
 *   - a tab switch writes the held record, coming back re-arms a fresh copy of
 *     the same question (the "Check has been replaced by the advance control"
 *     check sees a finished question), and the next tab switch writes it out -
 *     one copy per switch, however long the learner sits there;
 *   - a reload restores the finished session, which re-arms the same copy.
 *
 * The learner in the profile switched tabs and reloaded several times while the
 * answered question was up, which is exactly how seven copies of one question
 * were produced.
 */
describe('one question is one record, however often the learner leaves the page', () => {
  it('does not store a second copy when the learner switches tabs on an answered question', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);

    // Answer question 1; the page swaps Check for the advance control, and the
    // learner has not clicked it yet.
    await answerAndReplaceControls(0);

    // Four round trips to another tab and back, as the learner does while
    // comparing the timer against something else.
    for (let round = 0; round < 4; round += 1) {
      leaveThePage();
      await advance(2000);
    }

    const records = savedRecords(data);
    expect(records).toHaveLength(1);
    expect(
      new Set(records.map((record) => record['startedAt'])).size,
    ).toBe(1);
  });

  it('does not store a second copy when the page is reloaded on an answered question', async () => {
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);
    await answerAndReplaceControls(0);

    // The learner reloads the page instead of advancing.
    leaveThePage();
    await advance(1000);
    expect(savedRecords(data)).toHaveLength(1);

    // The page comes back with the same answered question on it: it is the same
    // question, timed once, so it is stored once.
    controller.dispose();
    controller = null;
    setPage(exerciseDom({ index: 0, total: 4 }));
    replaceCheckWithAdvance();
    controller = new ContentController();
    await controller.init();
    await advance(3000);
    leaveThePage();
    await advance(1000);

    expect(savedRecords(data)).toHaveLength(1);
  });

  it('still stores the question when the learner answers it and moves on', async () => {
    // The guard must not become a "never store anything" rule: the ordinary
    // answer-and-advance flow still produces exactly one record per question.
    const { data } = installChromeStorage();

    window.history.pushState({}, '', EXERCISE_A);
    setPage(exerciseDom({ index: 0, total: 4 }));
    controller = new ContentController();
    await controller.init();
    await advance(5000);

    await answerAndReplaceControls(0);
    setPage(exerciseDom({ index: 1, total: 4, stem: 'Add. 251+608' }));
    await advance(2500);

    await answerAndReplaceControls(1);
    setPage(exerciseDom({ index: 2, total: 4, stem: 'Add. 999+1' }));
    await advance(2500);

    const records = savedRecords(data);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record['questionIndex'])).toEqual([0, 1]);
    expect(new Set(records.map((record) => record['startedAt'])).size).toBe(2);
  });
});

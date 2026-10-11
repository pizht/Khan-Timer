/**
 * End-of-exercise summary tests.
 *
 * Covers the two halves of requirement 3:
 *   - the run model that decides WHICH records belong to "this attempt"
 *     (`src/storage.ts`), and
 *   - the card that presents them on the summary screen (`src/summary-view.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUMMARY_COLLAPSED_ATTR,
  SUMMARY_HOST_ID,
  SummaryView,
  buildSummaryRows,
} from '../src/summary-view.js';
import {
  RUN_TTL_MS,
  clearRun,
  loadRun,
  recordsForRun,
  runKey,
  sanitizeRun,
  saveRun,
} from '../src/storage.js';
import type { ActiveRun, QuestionRecord, SummaryRow } from '../src/types.js';

const NOW = 1_700_000_000_000;

/** In-memory stand-in for `chrome.storage.local`. */
class FakeArea {
  data: Record<string, unknown> = {};
  failOnSet = false;
  failOnGet = false;

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (this.failOnGet) throw new Error('storage read failed');
    if (keys === null) return { ...this.data };
    const out: Record<string, unknown> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key in this.data) out[key] = this.data[key];
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failOnSet) throw new Error('storage write failed');
    Object.assign(this.data, items);
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }
}

function makeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    version: 1,
    runId: 'run_1',
    exerciseKey: '/math/x/e/addition_4',
    startedAt: NOW,
    summarizedAt: null,
    lastQuestionIndex: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id: 'rec_1',
    questionKey: 'id:progress:1 of 4',
    exerciseKey: '/math/x/e/addition_4',
    startedAt: NOW,
    endedAt: NOW + 20_000,
    durationMs: 20_000,
    pausedMs: 0,
    mode: 'countup',
    limitMs: null,
    timedOut: false,
    firstSubmissionAt: NOW + 10_000,
    firstSubmissionOutcome: 'correct',
    endReason: 'answered-correct',
    status: 'completed',
    detectionConfidence: 'stable-id',
    wasPaused: false,
    runId: 'run_1',
    questionIndex: 0,
    questionTotal: 4,
    ...overrides,
  };
}

function makeRow(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    questionNumber: 1,
    bonus: false,
    durationMs: 20_000,
    pausedMs: 0,
    mode: 'countup',
    limitMs: null,
    timedOut: false,
    skipped: false,
    firstSubmissionOutcome: 'correct',
    endReason: 'answered-correct',
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('run model', () => {
  it('namespaces the run key by exercise', () => {
    expect(runKey('/math/x/e/addition_4')).toBe('run:/math/x/e/addition_4');
  });

  it('round-trips an active run', async () => {
    const area = new FakeArea();
    expect(await saveRun(area, makeRun())).toBe(true);
    const loaded = await loadRun(area, '/math/x/e/addition_4', NOW + 1000);
    expect(loaded).toMatchObject({ runId: 'run_1', summarizedAt: null });
  });

  it('returns null when there is no run yet (so a new one starts)', async () => {
    const area = new FakeArea();
    expect(await loadRun(area, '/math/x/e/addition_4', NOW)).toBeNull();
  });

  it('does not reuse a run whose summary has already been shown', async () => {
    const area = new FakeArea();
    await saveRun(area, makeRun({ summarizedAt: NOW + 60_000 }));
    expect(await loadRun(area, '/math/x/e/addition_4', NOW + 61_000)).toBeNull();
  });

  it('does not reuse a run older than the TTL', async () => {
    const area = new FakeArea();
    await saveRun(area, makeRun());
    expect(await loadRun(area, '/math/x/e/addition_4', NOW + 1000)).not.toBeNull();
    expect(await loadRun(area, '/math/x/e/addition_4', NOW + RUN_TTL_MS + 1)).toBeNull();
  });

  it('keeps runs of different exercises apart', async () => {
    const area = new FakeArea();
    await saveRun(area, makeRun({ exerciseKey: '/a', runId: 'run_a' }));
    await saveRun(area, makeRun({ exerciseKey: '/b', runId: 'run_b' }));
    expect((await loadRun(area, '/a', NOW))?.runId).toBe('run_a');
    expect((await loadRun(area, '/b', NOW))?.runId).toBe('run_b');
  });

  it('clears a run so the next attempt starts fresh', async () => {
    const area = new FakeArea();
    await saveRun(area, makeRun());
    expect(await clearRun(area, '/math/x/e/addition_4')).toBe(true);
    expect(await loadRun(area, '/math/x/e/addition_4', NOW)).toBeNull();
  });

  it('degrades safely without a storage area or on write failure', async () => {
    expect(await loadRun(null, 'x', NOW)).toBeNull();
    expect(await saveRun(null, makeRun())).toBe(false);
    expect(await clearRun(null, 'x')).toBe(false);
    const area = new FakeArea();
    area.failOnSet = true;
    expect(await saveRun(area, makeRun())).toBe(false);
    area.failOnGet = true;
    expect(await loadRun(area, 'x', NOW)).toBeNull();
  });

  it('rejects malformed run data', () => {
    expect(sanitizeRun(null)).toBeNull();
    expect(sanitizeRun({})).toBeNull();
    expect(sanitizeRun({ runId: 'r' })).toBeNull();
    expect(sanitizeRun({ runId: '', startedAt: 1 })).toBeNull();
    expect(sanitizeRun({ runId: 'r', startedAt: 'nope' })).toBeNull();
  });
});

describe('recordsForRun', () => {
  it('selects only the records of the given run, in capture order', () => {
    const records = [
      makeRecord({ id: 'a', runId: 'run_1', questionIndex: 0 }),
      makeRecord({ id: 'b', runId: 'run_1', questionIndex: 1 }),
      makeRecord({ id: 'c', runId: 'run_OLD', questionIndex: 0 }),
      makeRecord({ id: 'd', runId: 'run_1', questionIndex: 2 }),
    ];
    expect(recordsForRun(records, 'run_1').map((r) => r.id)).toEqual(['a', 'b', 'd']);
  });

  it('returns nothing rather than everything when there is no run id', () => {
    const records = [makeRecord({ runId: '' })];
    expect(recordsForRun(records, '')).toEqual([]);
  });

  it('excludes records written before the run model existed', () => {
    const legacy = makeRecord({ runId: '' });
    expect(recordsForRun([legacy], 'run_1')).toEqual([]);
  });
});

describe('buildSummaryRows (the card is a table of the exercise\'s questions)', () => {
  const rec = (overrides: Partial<QuestionRecord> = {}): QuestionRecord => makeRecord(overrides);

  it('places every row by the question number the record carries', () => {
    const rows = buildSummaryRows({
      records: [
        rec({ id: 'q1', questionIndex: 0, durationMs: 1000 }),
        rec({ id: 'q2', questionIndex: 1, durationMs: 2000 }),
        rec({ id: 'q3', questionIndex: 2, durationMs: 3000 }),
      ],
      questionTotal: 3,
    });
    expect(rows.map((row) => [row.questionNumber, row.durationMs])).toEqual([
      [1, 1000],
      [2, 2000],
      [3, 3000],
    ]);
  });

  it('marks a question with no timing data instead of moving the next one up', () => {
    // Question 2 was never timed (the learner left the practice before it was
    // read, or its record was lost): the row keeps its number and says so.
    const rows = buildSummaryRows({
      records: [
        rec({ id: 'q1', questionIndex: 0, durationMs: 4000 }),
        rec({ id: 'q3', questionIndex: 2, durationMs: 7000 }),
      ],
      questionTotal: 3,
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ questionNumber: 1, durationMs: 4000 });
    expect(rows[1]).toMatchObject({ questionNumber: 2, missing: true, durationMs: 0 });
    expect(rows[2]).toMatchObject({ questionNumber: 3, durationMs: 7000 });
  });

  it('reveals trailing numbers the page declared but this attempt never timed', () => {
    const rows = buildSummaryRows({
      records: [rec({ questionIndex: 0, durationMs: 1000 })],
      questionTotal: 4,
    });
    expect(rows.map((row) => row.questionNumber)).toEqual([1, 2, 3, 4]);
    expect(rows.filter((row) => row.missing)).toHaveLength(3);
  });

  it('adds up the stretches when the same question was timed twice in one attempt', () => {
    // The learner left the practice mid-question and came back to it.
    const rows = buildSummaryRows({
      records: [
        rec({ id: 'first', questionIndex: 1, durationMs: 4000, pausedMs: 1000, firstSubmissionOutcome: null }),
        rec({ id: 'second', questionIndex: 1, durationMs: 2500, pausedMs: 500, firstSubmissionOutcome: 'correct' }),
      ],
      questionTotal: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      questionNumber: 2,
      durationMs: 6500,
      pausedMs: 1500,
      firstSubmissionOutcome: 'correct',
    });
  });

  it('appends the bonus question after the numbered rows without repeating a number', () => {
    // Khan Academy restarts the progress index at 0 for the bonus question.
    const rows = buildSummaryRows({
      records: [
        rec({ id: 'q1', questionIndex: 0 }),
        rec({ id: 'q2', questionIndex: 1 }),
        rec({ id: 'bonus', questionIndex: 0, firstSubmissionOutcome: null }),
      ],
      questionTotal: 3,
    });
    expect(rows.map((row) => row.questionNumber)).toEqual([1, 2, 3]);
    expect(rows[2]).toMatchObject({ questionNumber: 3, bonus: true });
    expect(rows.filter((row) => row.bonus)).toHaveLength(1);
    expect(rows.filter((row) => row.questionNumber === 1)).toHaveLength(1);
  });

  it('keeps a record the page gave no position for, without inventing a number', () => {
    const rows = buildSummaryRows({
      records: [rec({ id: 'q1', questionIndex: 0 }), rec({ id: 'anon', questionIndex: null })],
      questionTotal: 1,
    });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ questionNumber: null, bonus: false });
  });
});

describe('SummaryView', () => {
  const mount = (insert: 'before-host' | 'append' = 'append'): SummaryView => {
    document.body.innerHTML = `
      <div id="host">
        <div id="score"><h1>Exercise complete!</h1><span>4/4 correct</span></div>
        <div id="signup"><h3>Want to save your progress?</h3></div>
      </div>
    `;
    const view = new SummaryView();
    view.mount(document.getElementById('host') as Element, insert);
    return view;
  };

  const shadowText = (): string => {
    const host = document.getElementById(SUMMARY_HOST_ID);
    return (host?.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  it('mounts an isolated Shadow DOM host that is marked so the detector ignores it', () => {
    mount();
    const host = document.getElementById(SUMMARY_HOST_ID);
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.getAttribute('data-khan-timer-ignore')).toBe('true');
    // The card must not be mistaken for question content.
    expect(host?.closest('form[name="answerform"]')).toBeNull();
  });

  it('places the card in normal flow immediately BEFORE the host', () => {
    // The real host is the exercise footer. The summary card above it measures
    // height:0 with visible overflow, so a card placed after it painted over
    // the page's results and its "Try again" button. Before the footer is
    // below all of that and simply pushes the footer down.
    mount('before-host');
    expect(Array.from(document.body.children).map((c) => c.id)).toEqual([
      SUMMARY_HOST_ID,
      'host',
    ]);
  });

  it('appends when the fallback host has no meaningful first child', () => {
    mount('append');
    const host = document.getElementById('host') as HTMLElement;
    expect(host.lastElementChild?.id).toBe(SUMMARY_HOST_ID);
  });

  it('renders one row per question with its duration', () => {
    const view = mount();
    view.render({
      collapsed: false,
      rows: [
        makeRow({ questionNumber: 1, durationMs: 12_000 }),
        makeRow({ questionNumber: 2, durationMs: 65_000, firstSubmissionOutcome: 'incorrect' }),
        makeRow({ questionNumber: 3, durationMs: 8_000, mode: 'countdown', limitMs: 60_000, timedOut: true }),
        makeRow({ questionNumber: 4, durationMs: 30_000, skipped: true, endReason: 'skipped' }),
      ]
    });
    const text = shadowText();
    expect(text).toContain('本轮每题用时');
    expect(text).toContain('第 1 题');
    expect(text).toContain('0:12');
    expect(text).toContain('第 2 题');
    expect(text).toContain('1:05');
    expect(text).toContain('第 3 题');
    expect(text).toContain('第 4 题');
    expect(text).toContain('共 4 题');
  });

  it('tags timed-out, skipped, correct and incorrect rows', () => {
    const view = mount();
    view.render({
      collapsed: false,
      rows: [
        makeRow({ questionNumber: 1, timedOut: true, mode: 'countdown', limitMs: 10_000 }),
        makeRow({ questionNumber: 2, skipped: true, endReason: 'skipped', firstSubmissionOutcome: null }),
        makeRow({ questionNumber: 3, firstSubmissionOutcome: 'correct' }),
        makeRow({ questionNumber: 4, firstSubmissionOutcome: 'incorrect' }),
      ]
    });
    const text = shadowText();
    expect(text).toContain('超时');
    expect(text).toContain('已跳过');
    expect(text).toContain('答对');
    expect(text).toContain('答错');
  });

  it('marks the optional bonus question', () => {
    const view = mount();
    view.render({
      collapsed: false,
      rows: [
        makeRow({ questionNumber: 1 }),
        makeRow({ questionNumber: 2 }),
        makeRow({ questionNumber: 3, bonus: true }),
      ],
    });
    expect(shadowText()).toContain('加试');
  });

  it('numbers rows by order, so a bonus question never repeats "第 1 题"', () => {
    // The page's own index restarts at 0 for the bonus question; the card must
    // still show an unambiguous sequence.
    const view = mount();
    view.render({
      collapsed: false,
      rows: [
        makeRow({ questionNumber: 1 }),
        makeRow({ questionNumber: 2 }),
        makeRow({ questionNumber: 3, bonus: true }),
      ],
    });
    const numbers = Array.from(
      document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelectorAll('td.num') ?? [],
    ).map((c) => (c.textContent ?? '').trim());
    expect(numbers[0]).toContain('第 1 题');
    expect(numbers[1]).toContain('第 2 题');
    expect(numbers[2]).toContain('第 3 题');
    expect(numbers.filter((n) => n.startsWith('第 1 题'))).toHaveLength(1);
  });

  it('has exactly two columns: the question and its time', () => {
    // The mode column was removed on request; the table is question + duration.
    const view = mount();
    view.render({
      collapsed: false,
      rows: [
        makeRow({ questionNumber: 1, mode: 'countdown', limitMs: 60_000 }),
        makeRow({ questionNumber: 2, mode: 'countup' }),
      ],
    });
    const root = document.getElementById(SUMMARY_HOST_ID)?.shadowRoot;
    const headers = Array.from(root?.querySelectorAll('thead th') ?? []).map((c) =>
      (c.textContent ?? '').trim(),
    );
    expect(headers).toEqual(['题目', '用时']);
    for (const tr of Array.from(root?.querySelectorAll('tbody tr') ?? [])) {
      expect(tr.querySelectorAll('td').length).toBe(2);
    }
    // No mode wording anywhere in the card.
    expect(shadowText()).not.toContain('正计时');
    expect(shadowText()).not.toContain('倒计时');
    expect(shadowText()).not.toContain('60s');
  });

  it('keeps paused time as a note under the duration, not a column', () => {
    const view = mount();
    view.render({
      collapsed: false,
      rows: [makeRow({ questionNumber: 1, mode: 'countdown', limitMs: 60_000, pausedMs: 5_000 })],
    });
    const root = document.getElementById(SUMMARY_HOST_ID)?.shadowRoot;
    const durCell = (root?.querySelector('td.dur')?.textContent ?? '').replace(/\s+/g, ' ');
    expect(durCell).toContain('0:20');
    expect(durCell).toContain('暂停 0:05');
    expect(root?.querySelectorAll('td.dur').length).toBe(1);
  });

  it('reports an empty state instead of pretending there is data', () => {
    const view = mount();
    view.render({ collapsed: false, rows: [] });
    const text = shadowText();
    expect(text).toContain('本轮没有记录到题目用时');
    expect(text).not.toContain('第 1 题');
  });

  it('re-rendering replaces rows rather than appending duplicates', () => {
    const view = mount();
    view.render({ collapsed: false, rows: [makeRow({ questionNumber: 1 })] });
    view.render({
      collapsed: false,
      rows: [makeRow({ questionNumber: 1 }), makeRow({ questionNumber: 2 })]
    });
    const rows = document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows?.length).toBe(2);
  });

  it('handles an unknown question number without printing "null"', () => {
    const view = mount();
    view.render({
      collapsed: false,
      rows: [makeRow({ questionNumber: null })]
    });
    const text = shadowText();
    expect(text).toContain('第 — 题');
    expect(text).not.toMatch(/null|undefined/);
  });

  it('destroy removes the host entirely', () => {
    const view = mount();
    view.render({ collapsed: false, rows: [makeRow()] });
    expect(view.isMounted()).toBe(true);
    view.destroy();
    expect(document.getElementById(SUMMARY_HOST_ID)).toBeNull();
    expect(view.isMounted()).toBe(false);
  });

  it('mounting twice replaces the previous host instead of stacking cards', () => {
    const view = mount();
    view.render({ collapsed: false, rows: [makeRow()] });
    view.mount(document.getElementById('host') as Element, 'append');
    expect(document.querySelectorAll(`#${SUMMARY_HOST_ID}`).length).toBe(1);
  });

  it('does not leak page CSS in or extension CSS out', () => {
    // The page tries to style the card; the Shadow DOM must block it.
    const style = document.createElement('style');
    style.textContent = `#${SUMMARY_HOST_ID} .card { display: none !important; }`;
    document.head.append(style);
    const view = mount();
    view.render({ collapsed: false, rows: [makeRow()] });
    const card = document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelector('.card');
    expect(card).not.toBeNull();
    // A rule outside the shadow root cannot match a node inside it.
    expect(getComputedStyle(card as Element).display).not.toBe('none');
  });
});

describe('sanitizeRecords keeps the run fields and tolerates legacy records', () => {
  it('preserves runId / questionIndex / questionTotal', async () => {
    const { sanitizeRecords } = await import('../src/storage.js');
    const [record] = sanitizeRecords({ version: 1, records: [makeRecord()] });
    expect(record).toMatchObject({ runId: 'run_1', questionIndex: 0, questionTotal: 4 });
  });

  it('defaults the new fields for records written before the run model', async () => {
    const { sanitizeRecords } = await import('../src/storage.js');
    const legacy = { ...makeRecord() } as Record<string, unknown>;
    delete legacy['runId'];
    delete legacy['questionIndex'];
    delete legacy['questionTotal'];
    const [record] = sanitizeRecords({ version: 1, records: [legacy] });
    expect(record).toMatchObject({ runId: '', questionIndex: null, questionTotal: null });
  });

  it('round-trips a skipped record status', async () => {
    const { sanitizeRecords } = await import('../src/storage.js');
    const [record] = sanitizeRecords({
      version: 1,
      records: [makeRecord({ status: 'skipped', endReason: 'skipped' })],
    });
    expect(record?.status).toBe('skipped');
    expect(record?.endReason).toBe('skipped');
  });
});

/* ================================================================== *
 * Collapsing the card
 * ================================================================== */

describe('SummaryView — collapse', () => {
  const mount = (opts: { collapsed: boolean; onToggle?: (c: boolean) => void }) => {
    document.body.innerHTML = '<div id="host"></div>';
    const view = new SummaryView(opts.onToggle ? { onToggleCollapsed: opts.onToggle } : {});
    view.mount(document.getElementById('host') as Element, 'before-host');
    view.render({ collapsed: opts.collapsed, rows: [makeRow({ questionNumber: 1 }), makeRow({ questionNumber: 2 })] });
    return view;
  };

  const root = (): ShadowRoot | null | undefined =>
    document.getElementById(SUMMARY_HOST_ID)?.shadowRoot;
  const card = (): Element | null => root()?.querySelector('.card') ?? null;
  const toggle = (): HTMLButtonElement | null =>
    root()?.querySelector('[data-role="toggle"]') ?? null;

  it('exposes a collapse control in the header', () => {
    mount({ collapsed: false });
    expect(toggle()).not.toBeNull();
    expect(toggle()?.tagName).toBe('BUTTON');
    expect(toggle()?.getAttribute('type')).toBe('button');
  });

  it('renders expanded by default, with the table visible', () => {
    mount({ collapsed: false });
    expect(card()?.classList.contains('collapsed')).toBe(false);
    expect(root()?.querySelectorAll('tbody tr').length).toBe(2);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    // The state is mirrored onto the host so it can be read from the page.
    expect(document.getElementById(SUMMARY_HOST_ID)?.getAttribute(SUMMARY_COLLAPSED_ATTR)).toBe('false');
  });

  it('hides the rows when collapsed but keeps the title and total', () => {
    mount({ collapsed: true });
    expect(card()?.classList.contains('collapsed')).toBe(true);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(SUMMARY_HOST_ID)?.getAttribute(SUMMARY_COLLAPSED_ATTR)).toBe('true');
    // The table is still in the DOM (so expansion is instant) but not rendered.
    const text = (root()?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('本轮每题用时');
    expect(text).toContain('共 2 题');
  });

  it('toggles on a click of the header, and reports the new state', () => {
    const seen: boolean[] = [];
    const view = mount({ collapsed: false, onToggle: (c) => seen.push(c) });
    (root()?.querySelector('[data-role="head"]') as HTMLElement).click();
    expect(view.isCollapsed()).toBe(true);
    expect(seen).toEqual([true]);
    (root()?.querySelector('[data-role="head"]') as HTMLElement).click();
    expect(view.isCollapsed()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('toggles exactly once when the control itself is clicked', () => {
    // The button sits inside the clickable header; only one handler may fire.
    const seen: boolean[] = [];
    const view = mount({ collapsed: false, onToggle: (c) => seen.push(c) });
    toggle()?.click();
    expect(seen).toHaveLength(1);
    expect(view.isCollapsed()).toBe(true);
  });

  it('is keyboard operable through the toggle button', () => {
    const seen: boolean[] = [];
    mount({ collapsed: false, onToggle: (c) => seen.push(c) });
    const button = toggle();
    expect(button?.getAttribute('aria-label')).toBe('折叠用时明细');
    button?.click();
    expect(seen).toEqual([true]);
  });

  it('reflects a persisted collapsed state on the next render', () => {
    const view = mount({ collapsed: false });
    view.render({ collapsed: true, rows: [makeRow({ questionNumber: 1 })] });
    expect(view.isCollapsed()).toBe(true);
    expect(card()?.classList.contains('collapsed')).toBe(true);
    view.render({ collapsed: false, rows: [makeRow({ questionNumber: 1 })] });
    expect(view.isCollapsed()).toBe(false);
  });

  it('still shows the empty state while collapsed', () => {
    const view = mount({ collapsed: false });
    view.render({ collapsed: true, rows: [] });
    const text = (root()?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('暂无数据');
    expect(text).toContain('本轮没有记录到题目用时');
  });

  it('does not leak the toggle click to the page', () => {
    // The card lives inside Khan Academy's page; a click must not reach the
    // site's own document-level handlers.
    let pageSawClick = false;
    const listener = (): void => {
      pageSawClick = true;
    };
    document.addEventListener('click', listener);
    try {
      mount({ collapsed: false });
      toggle()?.click();
      expect(pageSawClick).toBe(false);
    } finally {
      document.removeEventListener('click', listener);
    }
  });

  it('starting collapsed does not render the note either', () => {
    mount({ collapsed: true });
    expect(card()?.classList.contains('collapsed')).toBe(true);
    // The body is hidden via CSS; the card itself stays compact.
    expect(root()?.querySelector('.body')).not.toBeNull();
  });

  it('draws the collapse control as a plain chevron, not a boxed triangle', () => {
    mount({ collapsed: false });
    const button = toggle();
    // The mark is an inline SVG so its weight and colour do not depend on the
    // viewer's font (the old version used the text glyphs ▾ / ▸).
    expect(button?.querySelector('svg')).not.toBeNull();
    expect((button?.textContent ?? '').trim()).toBe('');
    // Still a real button: focusable, announced, and rotated by CSS alone.
    expect(button?.getAttribute('type')).toBe('button');
  });
});

/* ================================================================== *
 * Page-integrated presentation
 *
 * The card is page chrome, not a floating widget: square corners, no drop
 * shadow, one 1px divider of its own (the top) in the page's line colour, and a
 * borderless grey chevron for the collapse control. jsdom does not lay out, so
 * the stylesheet is asserted directly.
 * ================================================================== */

describe('SummaryView — page-integrated presentation', () => {
  const css = (): string => {
    document.body.innerHTML = '<div id="host"></div>';
    const view = new SummaryView();
    view.mount(document.getElementById('host') as Element, 'before-host');
    view.render({ collapsed: false, rows: [makeRow({ questionNumber: 1 })] });
    return document.getElementById(SUMMARY_HOST_ID)?.shadowRoot?.querySelector('style')
      ?.textContent ?? '';
  };

  it('has square corners and no drop shadow', () => {
    const sheet = css();
    expect(sheet).toMatch(/\.card\s*\{[^}]*border-radius:\s*0\s*;/);
    expect(sheet).toMatch(/\.card\s*\{[^}]*box-shadow:\s*none\s*;/);
  });

  it('leaves no gap between its bottom edge and the page divider below', () => {
    expect(css()).toMatch(/\.card\s*\{[^}]*margin:\s*16px\s+0\s+0\s*;/);
  });

  it('draws only a top divider, and in the page\'s own line colour', () => {
    const sheet = css();
    // No box: left/right/bottom are the page's own lines. Ours landed next to
    // them and rendered those edges 2px thick against 1px at the top.
    expect(sheet).toMatch(/\.card\s*\{[^}]*border:\s*0\s*;/);
    expect(sheet).toMatch(/\.card\s*\{[^}]*border-top:\s*1px\s+solid\s+#e1e1e1\s*;/);
    expect(sheet).not.toMatch(/\.card\s*\{[^}]*border:\s*1px\s+solid/);
  });

  it('styles the chevron button with no border, fill or corner radius', () => {
    const sheet = css();
    expect(sheet).toMatch(/\.toggle\s*\{[^}]*border:\s*0\s*;/);
    expect(sheet).toMatch(/\.toggle\s*\{[^}]*border-radius:\s*0\s*;/);
    expect(sheet).toMatch(/\.toggle\s*\{[^}]*background:\s*none\s*;/);
    // Collapsed = the same chevron turned to point right.
    expect(sheet).toMatch(/\.card\.collapsed\s+\.toggle\s+svg\s*\{[^}]*rotate\(-90deg\)/);
  });
});

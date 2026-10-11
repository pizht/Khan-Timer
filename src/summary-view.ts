/**
 * Per-question timing card injected into the end-of-exercise summary screen.
 *
 * Requirement: once every question in the exercise has been answered and the
 * learner reaches the summary, the summary must show how long each question of
 * *this* attempt took. The card can be collapsed down to its header line.
 *
 * Isolation follows the same approach as the floating panel (spec 2.3): the
 * card lives in its own Shadow DOM inside a marked host, so Khan Academy's CSS
 * cannot restyle it and its own CSS cannot leak into the page.
 *
 * Placement is chosen by measurement, not by guessing at class names: the
 * end-of-exercise screen builds its chrome from zero-height flex items whose
 * content is absolutely positioned, so a sibling inserted after the summary card
 * paints over the results. See `SUMMARY_HOST` in site-profile.ts.
 *
 * The card is only ever rendered from records already stored locally; it makes
 * no network calls and stores nothing.
 */

import type { SummaryRow } from './types.js';
import { formatDuration } from './timer-engine.js';

/** Id of the host element carrying the summary card. */
export const SUMMARY_HOST_ID = 'khan-academy-timer-summary';

/** Attribute marking the host, so the question detector can ignore it. */
export const SUMMARY_IGNORE_ATTR = 'data-khan-timer-ignore';

/**
 * Attribute mirroring the collapsed state onto the host element.
 *
 * Kept in the light DOM so it can be read from the page: it makes the state
 * verifiable from the outside (scripts/verify-extension.mjs asserts on it) and
 * gives support something to inspect without opening the shadow root.
 */
export const SUMMARY_COLLAPSED_ATTR = 'data-khan-timer-summary-collapsed';

const SHADOW_CSS = `
:host {
  all: initial;
  display: block;
  /* The host can land in a flex container. width:100% keeps it full width, and
     flex:0 0 auto deliberately does NOT grow: with flex-grow:1 in a column flex
     container the card stretched to the container's full height (measured:
     625px for a five-row table), which pushed page content around. Natural
     height is what we want. */
  width: 100%;
  flex: 0 0 auto;
  grid-column: 1 / -1;
}
* { box-sizing: border-box; }
.card {
  display: block;
  margin: 16px 0;
  padding: 14px 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: #0b214a;
  background: #ffffff;
  border: 1px solid rgba(11, 33, 74, 0.16);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(11, 33, 74, 0.08);
  text-align: left;
}
.card.collapsed { padding-bottom: 12px; }
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.head:hover .title { text-decoration: underline; }
.head:focus-visible { outline: 2px solid #1865f2; outline-offset: 3px; border-radius: 6px; }
.toggle {
  flex: 0 0 auto;
  order: -1;
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  border: 1px solid rgba(11, 33, 74, 0.2);
  border-radius: 6px;
  background: #f7f9fc;
  color: #0b214a;
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.toggle:hover { background: #eef2f8; }
.toggle:focus-visible { outline: 2px solid #1865f2; outline-offset: 1px; }
.title { flex: 1 1 auto; font-size: 15px; font-weight: 700; margin: 0; }
.total { flex: 0 0 auto; font-size: 13px; color: #4a5b7a; font-variant-numeric: tabular-nums; }
.card.collapsed .body { display: none; }
.body { margin-top: 10px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 8px; text-align: left; }
th {
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: #5b6b85; border-bottom: 1px solid rgba(11, 33, 74, 0.14);
}
tbody tr { border-bottom: 1px solid rgba(11, 33, 74, 0.07); }
tbody tr:last-child { border-bottom: 0; }
td.num { font-weight: 700; }
td.dur { font-weight: 700; font-size: 15px; }
th.dur, td.dur { text-align: right; }
.tag {
  display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; border-radius: 4px; padding: 1px 5px; margin-left: 6px;
  background: #eef2f8; color: #4a5b7a; vertical-align: middle;
}
.tag.expired { background: #fdecea; color: #c0392b; }
.tag.skipped { background: #fdf3e3; color: #7a5a12; }
.tag.correct { background: #e8f5ec; color: #1a7f4b; }
.tag.incorrect { background: #fdecea; color: #c0392b; }
.tag.bonus { background: #ece7fb; color: #4b3a99; }
.muted { color: #7a869c; font-size: 12px; }
.note { margin: 10px 0 0; font-size: 11px; color: #7a869c; }
.empty { margin: 0; font-size: 13px; color: #5b6b85; }
`;

export interface SummaryRenderInput {
  rows: SummaryRow[];
  /** Collapse the card down to its header line. */
  collapsed: boolean;
  /** Optional overline shown under the note, e.g. where the data lives. */
  storageNote?: string;
}

export interface SummaryViewCallbacks {
  /** The learner toggled the card; persist the new state. */
  onToggleCollapsed?: (collapsed: boolean) => void;
}

/**
 * The outcome badge for a row. The bonus marker is rendered separately (see
 * `bonusTag` in the row builder), so it is deliberately not returned here —
 * doing both printed "加试" twice.
 */
function tagFor(row: SummaryRow): { text: string; className: string } | null {
  if (row.skipped) return { text: '已跳过', className: 'tag skipped' };
  if (row.timedOut) return { text: '超时', className: 'tag expired' };
  if (row.firstSubmissionOutcome === 'correct') return { text: '答对', className: 'tag correct' };
  if (row.firstSubmissionOutcome === 'incorrect') return { text: '答错', className: 'tag incorrect' };
  return null;
}

const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface Refs {
  host: HTMLElement;
  card: HTMLDivElement;
  head: HTMLDivElement;
  toggle: HTMLButtonElement;
  total: HTMLSpanElement;
  body: HTMLDivElement;
}

export class SummaryView {
  private refs: Refs | null = null;
  /** Last rendered state, so the toggle and re-renders stay consistent. */
  private collapsed = false;
  private lastInput: SummaryRenderInput | null = null;

  constructor(private readonly callbacks: SummaryViewCallbacks = {}) {}

  /** True while the card is mounted in the document. */
  isMounted(): boolean {
    return this.refs !== null && this.refs.host.isConnected;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  mount(container: Element, insert: 'before-host' | 'append'): void {
    this.destroy();

    const host = document.createElement('div');
    host.id = SUMMARY_HOST_ID;
    host.setAttribute(SUMMARY_IGNORE_ATTR, 'true');
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="head" data-role="head">
        <button class="toggle" data-role="toggle" type="button"></button>
        <h2 class="title">本轮每题用时</h2>
        <span class="total" data-role="total"></span>
      </div>
      <div class="body" data-role="body"></div>
    `;
    root.append(style, card);

    const q = <T extends HTMLElement>(role: string): T => {
      const el = card.querySelector<T>(`[data-role="${role}"]`);
      if (!el) throw new Error(`summary card: missing node ${role}`);
      return el;
    };

    const refs: Refs = {
      host,
      card,
      head: q('head') as unknown as HTMLDivElement,
      toggle: q('toggle') as unknown as HTMLButtonElement,
      total: q('total') as unknown as HTMLSpanElement,
      body: q('body') as unknown as HTMLDivElement,
    };

    // One handler on the header. The toggle button is inside it, so a click on
    // the button bubbles here rather than needing its own handler (that would
    // toggle twice). Keyboard activation of the button produces a bubbling
    // click too, so Enter/Space work.
    refs.head.addEventListener('click', (event) => {
      // The card is inside the page: do not let the click reach Khan Academy's
      // own document-level handlers.
      event.stopPropagation();
      this.setCollapsed(!this.collapsed, true);
    });

    if (insert === 'before-host') {
      container.before(host);
    } else {
      container.append(host);
    }

    this.refs = refs;
    // Paint the collapsed state immediately, before the first render.
    this.applyCollapsed();
  }

  /** Toggle programmatically (also used by the header click handler). */
  setCollapsed(collapsed: boolean, notify = false): void {
    if (this.collapsed === collapsed) {
      this.applyCollapsed();
      return;
    }
    this.collapsed = collapsed;
    this.applyCollapsed();
    if (notify) this.callbacks.onToggleCollapsed?.(collapsed);
  }

  private applyCollapsed(): void {
    const refs = this.refs;
    if (!refs) return;
    refs.card.classList.toggle('collapsed', this.collapsed);
    refs.host.setAttribute(SUMMARY_COLLAPSED_ATTR, String(this.collapsed));
    refs.toggle.textContent = this.collapsed ? '\u25B8' : '\u25BE';
    refs.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    refs.toggle.setAttribute('aria-label', this.collapsed ? '展开用时明细' : '折叠用时明细');
    refs.toggle.title = this.collapsed ? '展开用时明细' : '折叠用时明细';
  }

  render(input: SummaryRenderInput): void {
    const refs = this.refs;
    if (!refs) return;
    this.lastInput = input;
    this.collapsed = input.collapsed;

    const { rows } = input;
    const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);
    refs.total.textContent =
      rows.length > 0
        ? `共 ${rows.length} 题 · 合计 ${formatDuration(totalMs)}`
        : '暂无数据';

    if (rows.length === 0) {
      refs.body.innerHTML =
        '<p class="empty">本轮没有记录到题目用时。请确认在答题时悬浮面板处于显示状态。</p>';
      this.applyCollapsed();
      return;
    }

    const bodyRows = rows
      .map((row) => {
        const tag = tagFor(row);
        const number = row.questionNumber === null ? '—' : String(row.questionNumber);
        const paused =
          row.pausedMs >= 1000
            ? `<div class="muted">暂停 ${escapeHtml(formatDuration(row.pausedMs))}</div>`
            : '';
        const bonusTag = row.bonus ? '<span class="tag bonus">加试</span>' : '';
        return `
          <tr>
            <td class="num">第 ${number} 题${bonusTag}${tag ? `<span class="${tag.className}">${tag.text}</span>` : ''}</td>
            <td class="dur">${escapeHtml(formatDuration(row.durationMs))}${paused}</td>
          </tr>
        `;
      })
      .join('');

    refs.body.innerHTML = `
      <table>
        <thead>
          <tr><th>题目</th><th class="dur">用时</th></tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <p class="note">${escapeHtml(
        input.storageNote ?? '用时数据只保存在本机浏览器中，不会上传到任何服务器。',
      )}</p>
    `;
    this.applyCollapsed();
  }

  /** Re-render with the last input (e.g. after the collapsed state changed). */
  refresh(): void {
    if (this.lastInput) this.render(this.lastInput);
  }

  destroy(): void {
    this.refs?.host.remove();
    this.refs = null;
    this.collapsed = false;
    this.lastInput = null;
  }
}

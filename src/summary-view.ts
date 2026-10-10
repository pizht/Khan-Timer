/**
 * Per-question timing card injected into the end-of-exercise summary screen.
 *
 * Requirement: once every question in the exercise has been answered and the
 * learner reaches the summary, the summary must show how long each question of
 * *this* attempt took.
 *
 * Isolation follows the same approach as the floating panel (spec 2.3): the
 * card lives in its own Shadow DOM inside a marked host, so Khan Academy's CSS
 * cannot restyle it and its own CSS cannot leak into the page.
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

const SHADOW_CSS = `
:host {
  all: initial;
  display: block;
  /* The host may land in a flex or grid container; claim a full row so the
     table is never squeezed into a narrow column. */
  width: 100%;
  flex: 1 0 100%;
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
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.title { font-size: 15px; font-weight: 700; margin: 0; }
.total { font-size: 13px; color: #4a5b7a; font-variant-numeric: tabular-nums; }
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
  /** Optional overline shown under the note, e.g. where the data lives. */
  storageNote?: string;
}

/**
 * The outcome badge for a row. The bonus marker is rendered separately (see
 * `bonusTag` in `render`), so it is deliberately not returned here — doing both
 * printed "加试" twice.
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

export class SummaryView {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;

  /** True while the card is mounted in the document. */
  isMounted(): boolean {
    return this.host !== null && this.host.isConnected;
  }

  mount(container: Element, insert: 'after-host' | 'append'): void {
    this.destroy();
    const host = document.createElement('div');
    host.id = SUMMARY_HOST_ID;
    host.setAttribute(SUMMARY_IGNORE_ATTR, 'true');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    const card = document.createElement('div');
    card.className = 'card';
    root.append(style, card);

    if (insert === 'after-host') {
      container.after(host);
    } else {
      container.append(host);
    }

    this.host = host;
    this.root = root;
  }

  render(input: SummaryRenderInput): void {
    if (!this.root) return;
    const card = this.root.querySelector('.card');
    if (!card) return;

    const { rows } = input;
    const totalMs = rows.reduce((sum, row) => sum + row.durationMs, 0);

    const head = `
      <div class="head">
        <h2 class="title">本轮每题用时</h2>
        <span class="total">${
          rows.length > 0
            ? `共 ${rows.length} 题 · 合计 ${escapeHtml(formatDuration(totalMs))}`
            : '暂无数据'
        }</span>
      </div>
    `;

    if (rows.length === 0) {
      card.innerHTML = `${head}<p class="empty">本轮没有记录到题目用时。请确认在答题时悬浮面板处于显示状态。</p>`;
      return;
    }

    const bodyRows = rows
      .map((row) => {
        const tag = tagFor(row);
        const number = row.questionNumber === null ? '—' : String(row.questionNumber);
        const mode = row.mode === 'countdown' ? '倒计时' : '正计时';
        const limit = row.limitMs === null ? '' : ` / ${Math.round(row.limitMs / 1000)}s`;
        const paused = row.pausedMs >= 1000 ? `<div class="muted">暂停 ${escapeHtml(formatDuration(row.pausedMs))}</div>` : '';
        const bonusTag = row.bonus ? '<span class="tag bonus">加试</span>' : '';
        return `
          <tr>
            <td class="num">第 ${number} 题${bonusTag}${tag ? `<span class="${tag.className}">${tag.text}</span>` : ''}</td>
            <td>${mode}${limit}${paused}</td>
            <td class="dur">${escapeHtml(formatDuration(row.durationMs))}</td>
          </tr>
        `;
      })
      .join('');

    card.innerHTML = `
      ${head}
      <table>
        <thead>
          <tr><th>题目</th><th>模式</th><th class="dur">用时</th></tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <p class="note">${
        input.storageNote
          ? escapeHtml(input.storageNote)
          : '用时数据只保存在本机浏览器中，不会上传到任何服务器。'
      }</p>
    `;
  }

  destroy(): void {
    this.root?.replaceChildren();
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}

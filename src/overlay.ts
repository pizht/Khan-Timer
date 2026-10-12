/**
 * In-page floating timer panel (spec 2.3).
 *
 * Isolation: the panel lives inside a Shadow DOM attached to a host element
 * marked with `OVERLAY_HOST_ID`. The shadow root means site CSS cannot reach
 * the panel's internals and the panel's CSS cannot leak into the site.
 *
 * Anti-misdetection: the host is appended to `document.body`, outside the
 * question region, and the detector additionally strips the host from any
 * fingerprint it computes. Panel updates therefore cannot look like a question
 * change (spec 2.3, 8.1).
 *
 * Rendering strategy: the DOM skeleton is built once and subsequent updates
 * only touch text nodes and class names, keeping per-frame work minimal.
 */

import type {
  DetectionConfidence,
  OverlayPosition,
  Settings,
  TimerMode,
  TimerPhase,
} from './types.js';
import { formatDuration } from './timer-engine.js';
import { t } from './i18n/index.js';
import { OVERLAY_HOST_ID } from './question-detector.js';

export interface OverlayState {
  mode: TimerMode;
  phase: TimerPhase;
  expired: boolean;
  elapsedMs: number;
  remainingMs: number | null;
  limitMs: number | null;
  questionKey: string | null;
  progress: string | null;
  confidence: DetectionConfidence;
  /**
   * Non-null when detection is degraded; shown as a visible warning. Only ever
   * rendered while the panel is visible, so a degraded state is never described
   * to a learner who is looking at a working clock.
   */
  warning: string | null;
  /** Short description of the last detection event, for transparency. */
  lastEvent: string;
  savedRecords: number;
}

export interface OverlayCallbacks {
  onTogglePause: () => void;
  onReset: () => void;
  onToggleCollapse: (collapsed: boolean) => void;
  onPositionChange: (position: OverlayPosition) => void;
}

/**
 * The shadow root's stylesheet.
 *
 * Built per mount rather than held as a constant because two of its rules carry
 * COPY, not just styling: the "done" / "paused" badges are drawn by
 * `.readout::after`, so their text comes from the message catalog. The values
 * are quoted through `JSON.stringify`, which is both valid CSS string syntax and
 * the only way a translation containing a quote can break out of the rule.
 */
function shadowCss(): string {
  return `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed;
  z-index: 2147483000;
  width: 232px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.35;
  color: #0b214a;
  background: #ffffff;
  border: 1px solid rgba(11, 33, 74, 0.14);
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(11, 33, 74, 0.18);
  overflow: hidden;
  user-select: none;
}
.panel.collapsed { width: auto; }
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  background: #0b214a;
  color: #ffffff;
  cursor: grab;
  touch-action: none;
}
.head.dragging { cursor: grabbing; }
.title {
  flex: 1 1 auto;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.icon-btn {
  flex: 0 0 auto;
  width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 5px;
  background: rgba(255,255,255,0.14); color: #ffffff;
  font-size: 12px; line-height: 1; cursor: pointer;
  font-family: inherit;
}
.icon-btn:hover { background: rgba(255,255,255,0.3); }
.icon-btn:focus-visible { outline: 2px solid #7ec3ff; outline-offset: 1px; }
.body { padding: 9px; }
.readout {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}
.time {
  font-variant-numeric: tabular-nums;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.mode-tag {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #4a5b7a;
  background: #eef2f8;
  border-radius: 4px;
  padding: 2px 5px;
}
.meta {
  display: flex; flex-wrap: wrap; gap: 4px 8px;
  font-size: 11px; color: #4a5b7a; margin-bottom: 8px;
}
.meta .k { font-weight: 600; color: #0b214a; }
.status-running .time { color: #0b214a; }
.status-paused .time { color: #8a6d1f; }
.status-finished .time { color: #1a7f4b; }
.status-finished .readout::after {
  content: ${JSON.stringify(t('overlay.statusFinished'))}; font-size: 11px; font-weight: 700; color: #1a7f4b;
}
.status-paused .readout::after {
  content: ${JSON.stringify(t('overlay.statusPaused'))}; font-size: 11px; font-weight: 700; color: #8a6d1f;
}
.status-expired .time { color: #c0392b; }
.status-expired .panel-time-row { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
.actions { display: flex; gap: 6px; }
.btn {
  flex: 1 1 0;
  padding: 7px 8px;
  border: 1px solid rgba(11,33,74,0.18);
  border-radius: 8px;
  background: #f7f9fc;
  color: #0b214a;
  font-family: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer;
}
.btn:hover { background: #eef2f8; }
.btn:focus-visible { outline: 2px solid #1865f2; outline-offset: 1px; }
.btn.primary { background: #1865f2; border-color: #1865f2; color: #ffffff; }
.btn.primary:hover { background: #1257d6; }
.warning {
  margin-top: 8px; padding: 6px 7px;
  background: #fdf3e3; border: 1px solid #f0d9ae; border-radius: 6px;
  color: #7a5a12; font-size: 11px;
}
.warning[hidden] { display: none; }
.foot {
  margin-top: 7px; padding-top: 6px;
  border-top: 1px solid rgba(11,33,74,0.1);
  font-size: 10px; color: #7a869c;
  display: flex; justify-content: space-between; gap: 6px;
}
/* The .foot rule sets display, which would beat the UA [hidden] rule. */
.foot[hidden] { display: none; }
.confidence-weak { color: #b06f00; }
.confidence-none { color: #c0392b; }
.pill {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 9px;
  font-variant-numeric: tabular-nums;
  font-weight: 700; font-size: 15px;
  cursor: pointer;
}
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #1865f2; }
.pill.paused .dot { background: #d9a821; }
.pill.expired .dot { background: #c0392b; animation: pulse 1s ease-in-out infinite; }
.pill.finished .dot { background: #1a7f4b; }
`;
}

interface Refs {
  host: HTMLElement;
  root: ShadowRoot;
  style: HTMLStyleElement;
  panel: HTMLDivElement;
  head: HTMLDivElement;
  body: HTMLDivElement;
  title: HTMLSpanElement;
  time: HTMLSpanElement;
  modeTag: HTMLSpanElement;
  meta: HTMLDivElement;
  warning: HTMLDivElement;
  foot: HTMLDivElement;
  collapseBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  pill: HTMLDivElement;
  pillTime: HTMLSpanElement;
}

export class OverlayView {
  private readonly callbacks: OverlayCallbacks;
  private settings: Settings;
  private refs: Refs | null = null;
  private state: OverlayState | null = null;
  private dragging = false;
  private dragOffset = { x: 0, y: 0 };
  private destroyed = false;

  constructor(callbacks: OverlayCallbacks, settings: Settings) {
    this.callbacks = callbacks;
    this.settings = settings;
  }

  mount(): void {
    if (this.destroyed) return;
    if (document.getElementById(OVERLAY_HOST_ID)) return;

    const host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    // A marker attribute the detector can exclude cheaply.
    host.setAttribute('data-khan-timer-ignore', 'true');
    // Born hidden, and hidden HERE rather than in the first render: the panel
    // must never be painted between being mounted and the controller's first
    // verdict. It is only ever shown by `setVisible(true)`, which the controller
    // calls once the page has confirmed a question is being solved.
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = shadowCss();

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head" data-role="head">
        <span class="title" data-role="title">${t('app.timerTitle')}</span>
        <button class="icon-btn" data-role="collapse" type="button" title="${t('overlay.collapse')}" aria-label="${t('overlay.collapse')}">–</button>
      </div>
      <div class="body" data-role="body">
        <div class="readout panel-time-row">
          <span class="time" data-role="time">0:00</span>
          <span class="mode-tag" data-role="mode">${t('mode.countup')}</span>
        </div>
        <div class="meta" data-role="meta"></div>
        <div class="actions">
          <button class="btn primary" data-role="pause" type="button">${t('overlay.pause')}</button>
          <button class="btn" data-role="reset" type="button">${t('overlay.reset')}</button>
        </div>
        <div class="warning" data-role="warning" hidden></div>
        <div class="foot" data-role="foot">
          <span data-role="event"></span>
          <span data-role="records"></span>
        </div>
      </div>
      <div class="pill" data-role="pill" style="display:none">
        <span class="dot"></span>
        <span class="pill-time" data-role="pill-time">0:00</span>
      </div>
    `;

    root.append(style, panel);

    const target = document.body ?? document.documentElement;
    target.appendChild(host);

    const q = <T extends HTMLElement>(role: string): T => {
      const el = panel.querySelector<T>(`[data-role="${role}"]`);
      if (!el) throw new Error(`overlay: missing node ${role}`);
      return el;
    };

    this.refs = {
      host,
      root,
      style,
      panel,
      head: q('head') as unknown as HTMLDivElement,
      body: q('body') as unknown as HTMLDivElement,
      title: q('title'),
      time: q('time'),
      modeTag: q('mode'),
      meta: q('meta') as unknown as HTMLDivElement,
      warning: q('warning') as unknown as HTMLDivElement,
      foot: q('foot') as unknown as HTMLDivElement,
      collapseBtn: q('collapse') as unknown as HTMLButtonElement,
      pauseBtn: q('pause') as unknown as HTMLButtonElement,
      resetBtn: q('reset') as unknown as HTMLButtonElement,
      pill: q('pill') as unknown as HTMLDivElement,
      pillTime: q('pill-time'),
    };

    // The body wrapper carries class names for state styling.
    this.refs.collapseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onToggleCollapse(!this.settings.overlayCollapsed);
    });
    this.refs.pauseBtn.addEventListener('click', () => this.callbacks.onTogglePause());
    this.refs.resetBtn.addEventListener('click', () => this.callbacks.onReset());
    this.refs.pill.addEventListener('click', () => this.callbacks.onToggleCollapse(false));

    this.refs.head.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.refs.head.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.refs.head.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.refs.head.addEventListener('pointercancel', (event) => this.onPointerUp(event));

    this.applySettings(this.settings);
  }

  destroy(): void {
    this.destroyed = true;
    const host = this.refs?.host;
    this.refs?.root.replaceChildren();
    host?.remove();
    this.refs = null;
  }

  /** Show or hide the whole panel. Driven by the controller, not by settings. */
  setVisible(visible: boolean): void {
    if (!this.refs) return;
    const next = visible ? '' : 'none';
    if (this.refs.host.style.display !== next) this.refs.host.style.display = next;
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    if (!this.refs) return;
    const collapsed = settings.overlayCollapsed;
    this.refs.body.style.display = collapsed ? 'none' : '';
    this.refs.pill.style.display = collapsed ? '' : 'none';
    // Diagnostics footer follows developer mode immediately, without waiting for the
    // next render tick.
    this.refs.foot.hidden = !settings.developerMode;
    this.refs.collapseBtn.textContent = collapsed ? '+' : '–';
    this.applyLabels();
    // Visibility is deliberately NOT set from `settings.overlayVisible` here:
    // the controller decides it from whether a question is being timed, so that
    // changing a setting cannot flash the panel onto a page with no question.
    this.applyPosition(settings.overlayPosition);
  }

  /**
   * Re-render the labels that are not derived from timer state, in the locale
   * now in force.
   *
   * Called when the learner changes the language in the popup. These labels are
   * the ones baked into the shadow DOM when the panel was mounted (the title, the
   * collapse control's accessible name) plus the two status badges the
   * stylesheet draws with `content:` — without this they would keep the language
   * the page was loaded with. The clock, the mode tag and the footer need no
   * help: `render()` looks every string up in the catalog on each call, and the
   * controller re-renders on its next tick.
   */
  applyLanguage(): void {
    if (!this.refs) return;
    this.refs.style.textContent = shadowCss();
    this.applyLabels();
    if (this.state) this.render(this.state);
  }

  /**
   * Every label the panel bakes in at mount, re-applied on demand.
   *
   * The clock, the mode tag, the pause control and the footer are NOT here:
   * `render()` looks those up in the catalog on every call, and the controller
   * re-renders on each tick.
   */
  private applyLabels(): void {
    const refs = this.refs;
    if (!refs) return;
    const label = this.settings.overlayCollapsed ? t('overlay.expand') : t('overlay.collapse');
    refs.title.textContent = t('app.timerTitle');
    refs.resetBtn.textContent = t('overlay.reset');
    refs.collapseBtn.title = label;
    refs.collapseBtn.setAttribute('aria-label', label);
  }

  private applyPosition(position: OverlayPosition): void {
    if (!this.refs) return;
    const { panel } = this.refs;
    panel.style.top = '';
    panel.style.bottom = '';
    panel.style.left = '';
    panel.style.right = '';
    const { anchor, x, y } = position;
    switch (anchor) {
      case 'top-left':
        panel.style.top = `${y}px`;
        panel.style.left = `${x}px`;
        break;
      case 'bottom-left':
        panel.style.bottom = `${y}px`;
        panel.style.left = `${x}px`;
        break;
      case 'bottom-right':
        panel.style.bottom = `${y}px`;
        panel.style.right = `${x}px`;
        break;
      case 'custom':
        panel.style.top = `${y}px`;
        panel.style.left = `${x}px`;
        break;
      case 'top-right':
      default:
        panel.style.top = `${y}px`;
        panel.style.right = `${x}px`;
        break;
    }
  }

  render(state: OverlayState): void {
    this.state = state;
    const refs = this.refs;
    if (!refs) return;

    const panelVisible = refs.host.style.display !== 'none';
    const isCountdown = state.mode === 'countdown';
    const displayMs = isCountdown && !state.expired ? (state.remainingMs ?? 0) : state.elapsedMs;
    const text = formatDuration(displayMs);

    refs.time.textContent = text;
    refs.pillTime.textContent = text;
    refs.modeTag.textContent = isCountdown ? t('mode.countdown') : t('mode.countup');

    // A finished question keeps its frozen value and shows that timing stopped
    // because the learner was done with it (answered correctly, or skipped).
    const status = state.expired
      ? 'expired'
      : state.phase === 'finished'
        ? 'finished'
        : state.phase === 'paused'
          ? 'paused'
          : 'running';
    refs.panel.classList.remove('status-running', 'status-paused', 'status-expired', 'status-finished');
    refs.panel.classList.add(`status-${status}`);
    refs.pill.classList.remove('paused', 'expired', 'finished');
    if (status === 'paused' || status === 'finished') refs.pill.classList.add(status);
    if (status === 'expired') refs.pill.classList.add('expired');

    refs.pauseBtn.textContent =
      state.phase === 'finished'
        ? t('overlay.finished')
        : state.phase === 'paused'
          ? t('overlay.resume')
          : t('overlay.pause');
    refs.pauseBtn.disabled = state.phase === 'finished';
    refs.pauseBtn.classList.toggle('primary', state.phase === 'running');

    // Meta line: limit, overrun, progress and question identity.
    const bits: string[] = [];
    if (isCountdown && state.limitMs !== null) {
      bits.push(
        `<span class="k">${t('overlay.metaLimit')}</span> ${Math.round(state.limitMs / 1000)}s`,
      );
    }
    if (state.expired) {
      bits.push(`<span class="k">${t('overlay.metaOverrun')}</span> +${formatDuration(
        Math.max(0, state.elapsedMs - (state.limitMs ?? 0)),
      )}`);
    }
    if (state.progress) {
      bits.push(`<span class="k">${t('overlay.metaProgress')}</span> ${escapeHtml(state.progress)}`);
    }
    // Detection internals are opt-in (popup → developer mode). Without it the panel
    // keeps only what a learner needs: the time, the limit and the progress.
    if (this.settings.developerMode) {
      const confidenceClass = `confidence-${state.confidence}`;
      const confidenceLabel = t(
        state.confidence === 'stable-id'
          ? 'overlay.confidenceStableId'
          : state.confidence === 'fingerprint'
            ? 'overlay.confidenceFingerprint'
            : state.confidence === 'weak'
              ? 'overlay.confidenceWeak'
              : 'overlay.confidenceNone',
      );
      bits.push(
        `<span class="${confidenceClass}">${t('overlay.metaConfidence', {
          level: confidenceLabel,
        })}</span>`,
      );
    }
    refs.meta.innerHTML = bits.join('');

    // A warning only makes sense while the panel is on screen: in the unidentified
    // state the panel is hidden, so rendering the text then would describe a state
    // the learner cannot see, and it would still be sitting there once detection
    // recovers.
    if (state.warning && panelVisible) {
      refs.warning.hidden = false;
      refs.warning.textContent = state.warning;
    } else {
      refs.warning.hidden = true;
      refs.warning.textContent = '';
    }

    // The footer (last detector event + saved-record count) is diagnostics, so
    // it is only rendered in developer mode. The record count is still visible in the
    // popup's History card.
    const eventEl = refs.foot.querySelector<HTMLElement>('[data-role="event"]');
    if (eventEl) eventEl.textContent = state.lastEvent;
    const recordsEl = refs.foot.querySelector<HTMLElement>('[data-role="records"]');
    if (recordsEl) {
      recordsEl.textContent = t('overlay.savedRecords', { count: state.savedRecords });
    }
    refs.foot.hidden = !this.settings.developerMode;
  }

  /* ---------------- dragging ---------------- */

  private onPointerDown(event: PointerEvent): void {
    if (!this.refs) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('button')) return; // do not drag from a button
    this.dragging = true;
    this.refs.head.classList.add('dragging');
    const rect = this.refs.panel.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.refs.head.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging || !this.refs) return;
    const x = Math.max(0, event.clientX - this.dragOffset.x);
    const y = Math.max(0, event.clientY - this.dragOffset.y);
    this.refs.panel.style.top = `${y}px`;
    this.refs.panel.style.left = `${x}px`;
    this.refs.panel.style.right = '';
    this.refs.panel.style.bottom = '';
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging || !this.refs) return;
    this.dragging = false;
    this.refs.head.classList.remove('dragging');
    try {
      this.refs.head.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer may already be released */
    }
    const rect = this.refs.panel.getBoundingClientRect();
    this.callbacks.onPositionChange({
      anchor: 'custom',
      x: Math.round(rect.left),
      y: Math.round(rect.top),
    });
  }

  /** Exposed for tests and diagnostics. */
  getState(): OverlayState | null {
    return this.state;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Overlay tests for the 开发者模式 gate.
 *
 * The floating panel is the only place a learner sees the timer while working,
 * so the detection internals it exposes (the confidence chip in the meta line
 * and the event/record footer) must stay behind the same opt-in setting as the
 * popup's diagnostics. The question progress, by contrast, is learner-facing
 * and must survive in both modes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { OverlayView, type OverlayState } from '../src/overlay.js';
import { OVERLAY_HOST_ID } from '../src/question-detector.js';
import { DEFAULT_SETTINGS } from '../src/storage.js';
import type { Settings } from '../src/types.js';

const noop = (): void => undefined;

function makeState(): OverlayState {
  return {
    mode: 'countup',
    phase: 'running',
    expired: false,
    elapsedMs: 12_000,
    remainingMs: null,
    limitMs: null,
    questionKey: 'id:abc123',
    progress: '2 of 5',
    confidence: 'stable-id',
    warning: null,
    lastEvent: '检测到新题目，计时开始',
    savedRecords: 2,
  };
}

let view: OverlayView | null = null;

function mountOverlay(overrides: Partial<Settings> = {}): ShadowRoot {
  view = new OverlayView(
    { onTogglePause: noop, onReset: noop, onToggleCollapse: noop, onPositionChange: noop },
    { ...DEFAULT_SETTINGS, ...overrides },
  );
  view.mount();
  view.render(makeState());
  const host = document.getElementById(OVERLAY_HOST_ID);
  if (!host?.shadowRoot) throw new Error('overlay host or shadow root missing');
  return host.shadowRoot;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe('overlay: 开发者模式 gating', () => {
  it('hides the detection internals while developer mode is off', () => {
    const root = mountOverlay({ developerMode: false });

    const meta = root.querySelector('[data-role="meta"]') as HTMLElement;
    expect(meta.textContent).toContain('进度');
    expect(meta.textContent).toContain('2 of 5');
    expect(meta.textContent).not.toContain('识别：');

    const foot = root.querySelector('[data-role="foot"]') as HTMLElement;
    expect(foot.hidden).toBe(true);
  });

  it('shows them once developer mode is on', () => {
    const root = mountOverlay({ developerMode: true });

    const meta = root.querySelector('[data-role="meta"]') as HTMLElement;
    expect(meta.textContent).toContain('进度');
    expect(meta.textContent).toContain('识别：题目ID');

    const foot = root.querySelector('[data-role="foot"]') as HTMLElement;
    expect(foot.hidden).toBe(false);
    expect(foot.textContent).toContain('检测到新题目，计时开始');
    expect(foot.textContent).toContain('已记录 2');
  });

  it('reacts to the setting changing while the panel is open', () => {
    const root = mountOverlay({ developerMode: false });
    const foot = root.querySelector('[data-role="foot"]') as HTMLElement;
    expect(foot.hidden).toBe(true);

    view?.applySettings({ ...DEFAULT_SETTINGS, developerMode: true });
    expect(foot.hidden).toBe(false);

    view?.applySettings({ ...DEFAULT_SETTINGS, developerMode: false });
    expect(foot.hidden).toBe(true);
    // The progress chip is not affected by any of this.
    const meta = root.querySelector('[data-role="meta"]') as HTMLElement;
    expect(meta.textContent).toContain('2 of 5');
  });
});

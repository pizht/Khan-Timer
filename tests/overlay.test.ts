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
import { setLocale, t } from '../src/i18n/index.js';
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
    lastEvent: t('event.started'),
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
    expect(meta.textContent).toContain(t('overlay.metaProgress'));
    expect(meta.textContent).toContain('2 of 5');
    // Asserted by class rather than by text: the chip is what must be absent,
    // whatever language its label would have been in.
    expect(meta.querySelector('.confidence-stable-id')).toBeNull();

    const foot = root.querySelector('[data-role="foot"]') as HTMLElement;
    expect(foot.hidden).toBe(true);
  });

  it('shows them once developer mode is on', () => {
    const root = mountOverlay({ developerMode: true });

    const meta = root.querySelector('[data-role="meta"]') as HTMLElement;
    expect(meta.textContent).toContain(t('overlay.metaProgress'));
    const chip = meta.querySelector('.confidence-stable-id');
    expect(chip?.textContent).toContain(t('overlay.confidenceStableId'));
    expect(meta.textContent).toContain(
      t('overlay.metaConfidence', { level: t('overlay.confidenceStableId') }),
    );

    const foot = root.querySelector('[data-role="foot"]') as HTMLElement;
    expect(foot.hidden).toBe(false);
    expect(foot.textContent).toContain(t('event.started'));
    expect(foot.textContent).toContain(t('overlay.savedRecords', { count: 2 }));
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

  it('re-letters an open panel when the language changes', () => {
    const root = mountOverlay();
    const text = (role: string): string =>
      (root.querySelector(`[data-role="${role}"]`) as HTMLElement).textContent ?? '';

    expect(text('title')).toBe(t('app.timerTitle'));
    expect(text('pause')).toBe(t('overlay.pause'));

    try {
      setLocale('zh-CN');
      view?.applyLanguage();

      // Labels baked into the shadow DOM at mount...
      expect(text('title')).toBe('题目计时');
      expect(text('pause')).toBe('暂停');
      expect(text('reset')).toBe('重置本题');
      // The collapse control draws a glyph; its label is the accessible name.
      const collapse = root.querySelector('[data-role="collapse"]');
      expect(collapse?.getAttribute('title')).toBe('折叠面板');
      expect(collapse?.getAttribute('aria-label')).toBe('折叠面板');
      // ...and the two badges the stylesheet draws with `content:`, which cannot
      // be reached by touching text nodes at all.
      const css = (root.querySelector('style') as HTMLStyleElement).textContent ?? '';
      expect(css).toContain('已完成');
      expect(css).toContain('已暂停');
    } finally {
      setLocale('auto');
      view?.applyLanguage();
    }

    expect(text('title')).toBe(t('app.timerTitle'));
    expect(text('pause')).toBe(t('overlay.pause'));
  });
});

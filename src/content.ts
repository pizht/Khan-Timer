/**
 * Content script entry point.
 *
 * The extension's behaviour lives in `controller.ts`; this file only decides
 * when the coordinator starts. Splitting the two keeps the coordinator free of
 * load-time side effects, so it can be driven directly from tests.
 */

import { ContentController } from './controller.js';

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

/**
 * The content script runs on every supported page. Initialise once, and only
 * when the document body exists so the overlay has somewhere to mount.
 */
function bootstrap(): void {
  const controller = new ContentController();
  controller.init().catch((error: unknown) => {
    // A failure here must be visible, not silent (spec 5.3).
    console.warn('[Khan Timer] initialisation failed:', error);
  });
  window.addEventListener('pagehide', () => controller.dispose(), { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}

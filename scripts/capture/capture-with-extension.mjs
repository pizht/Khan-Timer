#!/usr/bin/env node
/**
 * Capture reference screenshots with the extension loaded, so the overlay and
 * popup are visible in the images.
 *
 * Screenshots are evidence for the research folder, not part of the build.
 *
 * Usage: node capture-with-extension.mjs <exerciseUrl> <outDir>
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_ARG = process.argv[2];
const OUT_DIR = process.argv[3] ?? path.join(ROOT, 'references', 'screenshots');
const PORT = 10900 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unpackedExtensionId(absPath) {
  const digest = createHash('sha256').update(path.resolve(absPath)).digest('hex').slice(0, 32);
  return Array.from(digest)
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}

async function waitForDevTools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      /* not ready */
    }
    await sleep(500);
  }
  throw new Error('devtools endpoint never became ready');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = msg.id ? this.pending.get(msg.id) : null;
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value;
  }
  async screenshot(file, options = {}) {
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...options,
    });
    await writeFile(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'kat-shot-'));

  const edge = spawn(
    EDGE,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crash`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
      '--disable-features=Translate,MediaRouter', `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
      '--window-size=1440,900', URL_ARG,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  let cdp;
  try {
    const page = await waitForDevTools();
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    for (let i = 0; i < 60; i += 1) {
      const ok = await cdp.evaluate(`!!document.querySelector('form[name="answerform"]')`);
      if (ok) break;
      await sleep(1000);
    }
    // Khan Academy shows a donation interstitial over the exercise. Dismiss it
    // so the screenshots show the exercise itself.
    const dismissed = await cdp.evaluate(`(() => {
      const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const candidates = [
        document.querySelector('[data-testid="close-donate-banner"]'),
        document.querySelector('[data-testid="close-button"]'),
        ...Array.from(document.querySelectorAll('button,[role="button"]')).filter((b) =>
          /close|dismiss|no thanks|not now/.test(norm(b.textContent) + ' ' + norm(b.getAttribute('aria-label')))),
      ].filter(Boolean);
      for (const c of candidates) { try { c.click(); } catch {} }
      // The interstitial can also be a modal dialog; remove any that is not the
      // timer panel and not the cookie notice's action area.
      let removed = 0;
      for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        if (d.closest('#khan-academy-timer-host')) continue;
        if (/cookie|privacy/i.test(d.textContent || '')) continue;
        d.style.display = 'none';
        removed += 1;
      }
      return { clicked: candidates.length, removed };
    })()`);
    console.log(`  dismissed interstitial: ${JSON.stringify(dismissed)}`);
    await sleep(1000);

    // Let the timer run so the screenshot shows a real elapsed value.
    await sleep(8000);

    const shot1 = path.join(OUT_DIR, 'overlay-countup.png');
    await cdp.screenshot(shot1);
    console.log(`wrote ${shot1}`);

    // Countdown mode must be driven from a real extension context: the page
    // world has no access to chrome.storage. Use the popup page.
    const extensionIdForSettings = unpackedExtensionId(DIST);
    const settingsTarget = await (
      await fetch(
        `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(
          `chrome-extension://${extensionIdForSettings}/popup.html`,
        )}`,
        { method: 'PUT' },
      )
    ).json();
    const settingsCdp = await connect(settingsTarget.webSocketDebuggerUrl);
    // Give the popup's own script time to render and load stored settings.
    await sleep(2500);
    const applied = await settingsCdp.evaluate(`(async () => {
      const sel = document.getElementById('defaultMode');
      const lim = document.getElementById('countdownLimitSeconds');
      if (sel && lim) {
        sel.value = 'countdown';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        lim.value = '5';
        lim.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));
      }
      // Fall back to writing settings directly from this real extension
      // context if the popup UI was not ready in time.
      const current = (await chrome.storage.local.get('settings')).settings || {};
      if (current.defaultMode !== 'countdown') {
        await chrome.storage.local.set({ settings: Object.assign({}, current, {
          defaultMode: 'countdown', countdownLimitSeconds: 5, soundEnabled: false }) });
      }
      return (await chrome.storage.local.get('settings')).settings;
    })()`);
    console.log(`  countdown settings applied: ${JSON.stringify(applied)}`);

    // Close the settings tab and bring the exercise page back to the front:
    // opening a new target makes it active, which left the exercise page blank
    // in a previous run.
    await fetch(`http://127.0.0.1:${PORT}/json/close/${settingsTarget.id}`).catch(() => undefined);
    await sleep(800);
    await cdp.send('Page.bringToFront').catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    // Nudge the detector, then wait for the limit plus the overrun we want.
    await cdp.evaluate(`window.dispatchEvent(new Event('focus'))`).catch(() => undefined);
    await sleep(11000);
    const expiredState = await cdp.evaluate(`(() => {
      const h = document.getElementById('khan-academy-timer-host');
      const q = (r) => h && h.shadowRoot && h.shadowRoot.querySelector('[data-role="' + r + '"]');
      return { mode: q('mode') && q('mode').textContent, time: q('time') && q('time').textContent,
               meta: q('meta') && q('meta').textContent };
    })()`);
    console.log(`  panel at capture: ${JSON.stringify(expiredState)}`);
    const shot2 = path.join(OUT_DIR, 'overlay-countdown-expired.png');
    await cdp.screenshot(shot2);
    console.log(`wrote ${shot2}`);

    // Collapsed pill, to document the fold behaviour.
    await cdp.evaluate(`(() => {
      const h = document.getElementById('khan-academy-timer-host');
      const b = h && h.shadowRoot && h.shadowRoot.querySelector('[data-role="collapse"]');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(1200);
    const shot3 = path.join(OUT_DIR, 'overlay-collapsed.png');
    await cdp.screenshot(shot3);
    console.log(`wrote ${shot3}`);

    // The popup page (reuse the session opened for the settings change).
    const popupShotTarget = await (
      await fetch(
        `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(
          `chrome-extension://${extensionIdForSettings}/popup.html`,
        )}`,
        { method: 'PUT' },
      )
    ).json();
    const popupShotCdp = await connect(popupShotTarget.webSocketDebuggerUrl);
    await popupShotCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 820,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(3000);
    const shot4 = path.join(OUT_DIR, 'popup-settings.png');
    await popupShotCdp.screenshot(shot4);
    console.log(`wrote ${shot4}`);
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    edge.kill('SIGKILL');
    await sleep(600);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});

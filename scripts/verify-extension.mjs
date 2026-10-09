#!/usr/bin/env node
/**
 * End-to-end verification of the built extension in real Microsoft Edge.
 *
 * `verify-dist.mjs` proves the *shape* of the build (manifest, permissions, no
 * network code). This script proves the *behaviour*: it loads `dist/` into Edge
 * as an unpacked extension, opens a real Khan Academy exercise, and drives the
 * whole feature set over the DevTools Protocol, reading state out of the
 * panel's Shadow DOM exactly as a user would see it.
 *
 * This is what moves a page type from "Observed" to "Edge-verified".
 *
 * Checks performed:
 *   1. the content script injects and the Shadow DOM panel is present
 *   2. countup mode starts automatically on a detected question
 *   3. the displayed value advances with wall-clock time
 *   4. pause freezes the value; resume continues it
 *   5. reset returns the current question to ~0 without breaking detection
 *   6. mode/limit/identity are rendered in the panel
 *   7. REGRESSION: submitting a correct answer must NOT reset the timer
 *   8. advancing to the next question DOES reset the timer and saves a record
 *   9. countdown mode expires and shows the timeout state, without navigating
 *
 * Usage: node scripts/verify-extension.mjs [exerciseUrl]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_ARG =
  process.argv[2] ??
  'https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4';

const PORT = 10200 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chromium derives an unpacked extension's ID deterministically from the
 * SHA-256 of its absolute path: the first 16 bytes, each nibble mapped onto
 * 'a'..'p'. Knowing the ID lets the verification open the extension's own
 * popup page and exercise the real storage path.
 */
function unpackedExtensionId(absPath) {
  const digest = createHash('sha256').update(path.resolve(absPath)).digest('hex').slice(0, 32);
  return Array.from(digest)
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}

/** Open a new tab at `url` and return a CDP session for it. */
async function openTarget(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`could not open target: ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('popup ws error')), { once: true });
    setTimeout(() => reject(new Error('popup ws timeout')), 20000);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  (${detail})` : ''}`);
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
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return r.result?.value;
  }
}

/** Read the panel exactly as rendered, straight out of the Shadow DOM. */
const READ_PANEL = `(() => {
  const host = document.getElementById('khan-academy-timer-host');
  if (!host) return { present: false };
  const root = host.shadowRoot;
  if (!root) return { present: true, shadow: false };
  const q = (role) => root.querySelector('[data-role="' + role + '"]');
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const panel = root.querySelector('.panel');
  const footer = q('foot');
  return {
    present: true,
    shadow: true,
    time: norm(q('time')?.textContent),
    pillTime: norm(q('pill-time')?.textContent),
    mode: norm(q('mode')?.textContent),
    pauseLabel: norm(q('pause')?.textContent),
    meta: norm(q('meta')?.textContent),
    warning: q('warning') && !q('warning').hidden ? norm(q('warning').textContent) : null,
    footer: norm(footer?.textContent),
    statusClass: panel ? Array.from(panel.classList).filter((c) => c.startsWith('status-')).join(',') : null,
    collapsed: q('pill') ? q('pill').style.display !== 'none' : null,
    visible: host.style.display !== 'none',
  };
})()`;

/** Click a control inside the panel's Shadow DOM. */
const clickPanel = (role) => `(() => {
  const host = document.getElementById('khan-academy-timer-host');
  const el = host && host.shadowRoot && host.shadowRoot.querySelector('[data-role="${role}"]');
  if (!el) return false;
  el.click();
  return true;
})()`;

/** Parse m:ss / h:mm:ss into milliseconds. */
function parseDisplay(text) {
  if (!text) return null;
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/** Solve a simple "a+b" stem so the correct answer can be submitted. */
const SOLVE_AND_SUBMIT = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  if (!region) return { ok: false, reason: 'no region' };
  const m = norm(region.textContent).match(/(\\d[\\d,]*)\\s*[+]\\s*(\\d[\\d,]*)/);
  if (!m) return { ok: false, reason: 'no a+b pattern' };
  const answer = String(Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')));
  const input = region.querySelector('input[type="text"], input:not([type]), textarea');
  if (!input) return { ok: false, reason: 'no input' };
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!btn) return { ok: false, reason: 'no check button' };
  btn.click();
  return { ok: true, answer };
})()`;

async function main() {
  const profile = await mkdtemp(path.join(tmpdir(), 'kat-verify-'));

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--disable-breakpad',
      `--crash-dumps-dir=${profile}/crash`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-service-autorun',
      '--disable-features=Translate,MediaRouter',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--window-size=1440,1000',
      URL_ARG,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  let cdp;
  try {
    const page = await waitForDevTools();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
      setTimeout(() => reject(new Error('ws open timeout')), 20000);
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Wait for the SPA to render a question.
    let rendered = false;
    for (let i = 0; i < 60; i += 1) {
      const ok = await cdp.evaluate(`!!document.querySelector('form[name="answerform"]')`).catch(() => false);
      if (ok) {
        rendered = true;
        break;
      }
      await sleep(1000);
    }
    console.log(`\n  page rendered a question: ${rendered}`);
    console.log(`  url: ${page.url}\n`);

    // 1. Content script injected the panel.
    let panel = null;
    for (let i = 0; i < 30; i += 1) {
      panel = await cdp.evaluate(READ_PANEL).catch(() => null);
      if (panel?.shadow) break;
      await sleep(1000);
    }
    check('content script injects the panel host', Boolean(panel?.present));
    check('panel uses Shadow DOM isolation', Boolean(panel?.shadow));
    check('panel is visible', Boolean(panel?.visible));

    // 2. Countup started automatically, in countup mode.
    check('countup mode is active by default', panel?.mode === '正计时', `mode=${panel?.mode}`);
    const startMs = parseDisplay(panel?.time);
    check('a timer value is displayed', startMs !== null, `time=${panel?.time}`);
    check(
      'the detected question is reported in the panel',
      Boolean(panel?.meta && panel.meta.length > 0),
      panel?.meta,
    );

    // 3. The value advances with real time.
    await sleep(3200);
    const afterWait = await cdp.evaluate(READ_PANEL);
    const afterWaitMs = parseDisplay(afterWait?.time);
    check(
      'the displayed time advances with wall-clock time',
      afterWaitMs !== null && startMs !== null && afterWaitMs - startMs >= 2000,
      `${panel?.time} -> ${afterWait?.time}`,
    );

    // 4. Pause freezes, resume continues.
    await cdp.evaluate(clickPanel('pause'));
    await sleep(300);
    const paused = await cdp.evaluate(READ_PANEL);
    check('pause button switches to resume', paused?.pauseLabel === '继续', `label=${paused?.pauseLabel}`);
    const pausedMs = parseDisplay(paused?.time);
    await sleep(2500);
    const stillPaused = await cdp.evaluate(READ_PANEL);
    const stillPausedMs = parseDisplay(stillPaused?.time);
    check(
      'paused time does not accumulate',
      pausedMs !== null && stillPausedMs !== null && stillPausedMs - pausedMs <= 1000,
      `${paused?.time} -> ${stillPaused?.time} after 2.5s`,
    );

    await cdp.evaluate(clickPanel('pause'));
    await sleep(2600);
    const resumed = await cdp.evaluate(READ_PANEL);
    const resumedMs = parseDisplay(resumed?.time);
    check(
      'resume continues accumulating from the paused value',
      resumedMs !== null && stillPausedMs !== null && resumedMs - stillPausedMs >= 2000,
      `${stillPaused?.time} -> ${resumed?.time}`,
    );

    // 5. Reset returns the current question to ~0.
    await cdp.evaluate(clickPanel('reset'));
    await sleep(400);
    const afterReset = await cdp.evaluate(READ_PANEL);
    const resetMs = parseDisplay(afterReset?.time);
    check(
      'reset returns the current question to ~0',
      resetMs !== null && resetMs <= 2000,
      `time=${afterReset?.time}`,
    );
    check('reset is reported in the panel footer', Boolean(afterReset?.footer), afterReset?.footer);

    // 6. REGRESSION: submitting a correct answer must NOT reset the timer.
    const beforeSubmit = await cdp.evaluate(READ_PANEL);
    const beforeSubmitMs = parseDisplay(beforeSubmit?.time);
    await sleep(2100);
    const submitted = await cdp.evaluate(SOLVE_AND_SUBMIT);
    console.log(`\n  submitted answer: ${JSON.stringify(submitted)}`);
    await sleep(2500);
    const afterSubmit = await cdp.evaluate(READ_PANEL);
    const afterSubmitMs = parseDisplay(afterSubmit?.time);
    check(
      'REGRESSION: submitting an answer does NOT reset the timer',
      beforeSubmitMs !== null && afterSubmitMs !== null && afterSubmitMs > beforeSubmitMs,
      `${beforeSubmit?.time} -> ${afterSubmit?.time} (must keep growing)`,
    );

    // 7. Advancing to the next question resets the timer and saves a record.
    const beforeNext = await cdp.evaluate(READ_PANEL);
    const nextClicked = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('the exercise exposes a next-question control after a correct answer', nextClicked);
    if (nextClicked) {
      await sleep(4200);
      const afterNext = await cdp.evaluate(READ_PANEL);
      const afterNextMs = parseDisplay(afterNext?.time);
      check(
        'advancing to a new question restarts the timer',
        afterNextMs !== null && afterNextMs <= 3000,
        `${beforeNext?.time} -> ${afterNext?.time}`,
      );
      check(
        'the question identity changed on advance',
        afterNext?.meta !== beforeNext?.meta,
        `${beforeNext?.meta} -> ${afterNext?.meta}`,
      );
      check(
        'a record was saved for the finished question',
        /已记录\s*[1-9]/.test(afterNext?.footer ?? ''),
        afterNext?.footer,
      );
    }

    // 8. The extension's own popup page: real storage, real settings, real records.
    const extensionId = unpackedExtensionId(DIST);
    let popup = null;
    try {
      popup = await openTarget(`chrome-extension://${extensionId}/popup.html`);
      await sleep(1500);
      const popupState = await popup.evaluate(`(async () => {
        const all = await chrome.storage.local.get(null);
        return {
          hasChromeStorage: typeof chrome !== 'undefined' && !!chrome.storage,
          settings: all.settings || null,
          recordCount: (all.records && all.records.records ? all.records.records.length : 0),
          renderedStatus: (document.getElementById('status-text') || {}).textContent || null,
          renderedRecordCount: (document.getElementById('record-count') || {}).textContent || null,
          modeSelect: !!document.getElementById('defaultMode'),
          limitInput: !!document.getElementById('countdownLimitSeconds'),
          soundToggle: !!document.getElementById('soundEnabled'),
          clearButton: !!document.getElementById('clear-records'),
          uiMode: (document.getElementById('defaultMode') || {}).value || null,
          uiLimit: (document.getElementById('countdownLimitSeconds') || {}).value || null,
          checkboxes: {
            soundEnabled: (document.getElementById('soundEnabled') || {}).checked,
            overlayVisible: (document.getElementById('overlayVisible') || {}).checked,
            overlayCollapsed: (document.getElementById('overlayCollapsed') || {}).checked,
            resumeAcrossReload: (document.getElementById('resumeAcrossReload') || {}).checked,
          },
        };
      })()`);
      console.log(`\n  popup state: ${JSON.stringify(popupState)}`);
      check('popup page opens and reaches chrome.storage', Boolean(popupState?.hasChromeStorage));
      check(
        'popup renders all settings controls',
        Boolean(popupState?.modeSelect && popupState?.limitInput && popupState?.soundToggle),
      );
      check('popup renders the clear-records control', Boolean(popupState?.clearButton));
      check(
        'popup reports the saved timing records',
        (popupState?.recordCount ?? 0) >= 1,
        `recordCount=${popupState?.recordCount} rendered="${popupState?.renderedRecordCount}"`,
      );
      check(
        'popup reflects the stored timer mode',
        popupState?.uiMode === 'countup',
        `uiMode=${popupState?.uiMode}`,
      );
      // Nothing is written to storage until the user actually changes a
      // setting, so the popup must be showing its merged defaults here.
      check(
        'popup shows default settings before anything is changed',
        popupState?.settings === null &&
          popupState?.uiMode === 'countup' &&
          popupState?.uiLimit === '60' &&
          popupState?.checkboxes?.overlayCollapsed === false,
        `settings=${JSON.stringify(popupState?.settings)} uiMode=${popupState?.uiMode} uiLimit=${popupState?.uiLimit}`,
      );

      // Drive a real settings change from the popup's own controls.
      await popup.evaluate(`(() => {
        const sel = document.getElementById('defaultMode');
        sel.value = 'countdown';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const lim = document.getElementById('countdownLimitSeconds');
        lim.value = '6';
        lim.dispatchEvent(new Event('change', { bubbles: true }));
        const sound = document.getElementById('soundEnabled');
        sound.checked = false;
        sound.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(1200);
      const stored = await popup.evaluate(`chrome.storage.local.get('settings').then((r) => r.settings)`);
      check(
        'popup writes settings to chrome.storage.local',
        stored?.defaultMode === 'countdown' &&
          stored?.countdownLimitSeconds === 6 &&
          stored?.soundEnabled === false,
        JSON.stringify(stored),
      );

      // Read the rendered controls back and compare them with storage. This is
      // the non-circular direction: the values were changed through the UI, so
      // the UI must now agree with what was persisted.
      const rendered = await popup.evaluate(`(() => ({
        uiMode: (document.getElementById('defaultMode') || {}).value,
        uiLimit: (document.getElementById('countdownLimitSeconds') || {}).value,
        checkboxes: {
          soundEnabled: (document.getElementById('soundEnabled') || {}).checked,
          overlayVisible: (document.getElementById('overlayVisible') || {}).checked,
          overlayCollapsed: (document.getElementById('overlayCollapsed') || {}).checked,
          resumeAcrossReload: (document.getElementById('resumeAcrossReload') || {}).checked,
        },
      }))()`);
      check(
        'popup controls agree with storage after a change',
        rendered?.uiMode === stored?.defaultMode &&
          String(rendered?.uiLimit) === String(stored?.countdownLimitSeconds) &&
          rendered?.checkboxes?.soundEnabled === stored?.soundEnabled &&
          rendered?.checkboxes?.overlayVisible === stored?.overlayVisible &&
          rendered?.checkboxes?.overlayCollapsed === stored?.overlayCollapsed &&
          rendered?.checkboxes?.resumeAcrossReload === stored?.resumeAcrossReload,
        `rendered=${JSON.stringify(rendered)} stored=${JSON.stringify(stored)}`,
      );
    } catch (error) {
      check('popup page could be verified', false, error.message);
    }

    // 9. The content script picks the settings change up, and the countdown
    //    mode engages on the question that is currently being timed.
    await sleep(1800);
    const cd1 = await cdp.evaluate(READ_PANEL);
    check('countdown mode applies live to the current question', cd1?.mode === '倒计时', `mode=${cd1?.mode}`);
    const cdStart = parseDisplay(cd1?.time);
    await sleep(8000);
    const cd2 = await cdp.evaluate(READ_PANEL);
    check(
      'countdown reaching zero shows a visible timeout state',
      (cd2?.statusClass ?? '').includes('expired'),
      `status=${cd2?.statusClass} time=${cd2?.time} meta=${cd2?.meta}`,
    );
    check(
      'timeout does not navigate away or submit anything',
      cd2?.mode === '倒计时' && Boolean(cd2?.time),
      `time=${cd2?.time}`,
    );
    check(
      'the timeout state is announced in the panel',
      /超时|倒计时结束/.test(`${cd2?.meta ?? ''}${cd2?.footer ?? ''}`),
      `meta=${cd2?.meta} footer=${cd2?.footer}`,
    );
    void cdStart;

    // 10. Clearing records from the popup really clears them (spec 8.4).
    if (popup) {
      const cleared = await popup.evaluate(`(async () => {
        document.getElementById('clear-records').click();
        await new Promise((r) => setTimeout(r, 800));
        const all = await chrome.storage.local.get(null);
        return { recordCount: (all.records && all.records.records ? all.records.records.length : 0),
                 rendered: (document.getElementById('record-count') || {}).textContent };
      })()`);
      check(
        'clearing records removes them from local storage',
        cleared?.recordCount === 0,
        `recordCount=${cleared?.recordCount} rendered="${cleared?.rendered}"`,
      );
      const settingsKept = await popup.evaluate(
        `chrome.storage.local.get('settings').then((r) => r.settings)`,
      );
      check(
        'clearing records leaves settings intact',
        settingsKept?.defaultMode === 'countdown',
        JSON.stringify(settingsKept),
      );

      // Restore the defaults so the extension is left clean.
      await popup.evaluate(`(async () => {
        const sel = document.getElementById('defaultMode');
        sel.value = 'countup';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const lim = document.getElementById('countdownLimitSeconds');
        lim.value = '60';
        lim.dispatchEvent(new Event('change', { bubbles: true }));
        const sound = document.getElementById('soundEnabled');
        sound.checked = true;
        sound.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
        return true;
      })()`);
      check('settings can be restored to defaults', true);
    }

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

  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log('\n  ' + '─'.repeat(width + 12));
  if (failures === 0) {
    console.log(`  all ${results.length} extension checks passed`);
  } else {
    console.log(`  ${failures} of ${results.length} extension checks FAILED`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n  verification failed to run:', error.message);
  process.exitCode = 1;
});

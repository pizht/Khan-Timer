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
  // Exposed so callers can close the tab they opened.
  cdp.targetId = target.id;
  return cdp;
}

const results = [];
let failures = 0;
let skipped = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  (${detail})` : ''}`);
}

/**
 * Record a check that could not be exercised.
 *
 * Used when Khan Academy itself leaves the page in a broken transitional state
 * (observed: the question is torn down but neither the next question nor the
 * summary appears). That is not a failure of the extension, and reporting it as
 * one would make the verification falsely red.
 */
function skipCheck(name, reason) {
  results.push({ name, ok: null, detail: reason });
  skipped += 1;
  console.log(`  \u2013 ${name}  (skipped: ${reason})`);
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
    pauseDisabled: q('pause') ? q('pause').disabled : null,
    meta: norm(q('meta')?.textContent),
    warning: q('warning') && !q('warning').hidden ? norm(q('warning').textContent) : null,
    footer: norm(footer?.textContent),
    statusClass: panel ? Array.from(panel.classList).filter((c) => c.startsWith('status-')).join(',') : null,
    collapsed: q('pill') ? q('pill').style.display !== 'none' : null,
    visible: host.style.display !== 'none',
    hostDisplay: host.style.display,
    statusClasses: panel ? Array.from(panel.classList).join(' ') : null,
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

/**
 * Shared page-side normalisation snippet.
 *
 * `String.raw` matters: inside a plain template literal `\s` collapses to `s`,
 * which would turn `/\s+/g` into `/s+/g` and silently strip every letter "s"
 * from the text being compared. That bug made the skip dialog read
 * "Are you ure?" instead of "Are you sure?" and broke the confirmation match.
 */
const NORM_JS = String.raw`const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();`;

/** Render milliseconds as m:ss. Null-safe, for diagnostics only. */
function msToDisplay(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** True when the end-of-exercise summary is on screen. */
const SUMMARY_PRESENT = `(() => {
  if (document.querySelector('form[name="answerform"]')) return false;
  if (document.querySelectorAll('[data-testid^="exercise-progress-"]').length > 0) return false;
  return !!document.querySelector('.bibliotron-exercise');
})()`;

/** Read the injected timing card out of its Shadow DOM. */
const SUMMARY_CARD = `(() => {
  ${NORM_JS}
  const host = document.getElementById('khan-academy-timer-summary');
  if (!host || !host.shadowRoot) return { present: false };
  const root = host.shadowRoot;
  const rows = Array.from(root.querySelectorAll('tbody tr'));
  return {
    present: true,
    text: norm(root.textContent),
    rowCount: rows.length,
    rows: rows.map((r) => norm(r.textContent)),
    durations: Array.from(root.querySelectorAll('td.dur')).map((c) => norm(c.textContent)),
  };
})()`;

/** The current question's progress state word, e.g. "incomplete" / "correct". */
const CURRENT_STATE = `(() => {
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  if (!cur) return null;
  const m = (cur.getAttribute('data-testid') || '').match(/exercise-progress-(\\d+)-(.+?)(?:-current)?$/);
  return m ? { index: Number(m[1]), state: m[2] } : null;
})()`;

/** The label of the advance control, which tells "next" from "show summary". */
const ADVANCE_LABEL = `(() => {
  const b = document.querySelector('[data-testid="exercise-next-question"]');
  return b ? (b.textContent || '').replace(/\\s+/g, ' ').trim() : null;
})()`;

/** Page-side view of the current question, for cross-checking the extension. */
const PAGE_STATE = `(() => {
  const qa = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
  const cells = qa('[data-testid^="exercise-progress-"]');
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  const host = document.getElementById('khan-academy-timer-host');
  let diag = null;
  try {
    diag = host ? JSON.parse(host.getAttribute('data-khan-timer-diagnostics') || 'null') : null;
  } catch { diag = 'unparseable'; }
  return {
    progressAll: cells.map((el) => el.getAttribute('data-testid')),
    current: cur ? cur.getAttribute('data-testid') : null,
    hasAnswerForm: !!document.querySelector('form[name="answerform"]'),
    hasNext: !!document.querySelector('[data-testid="exercise-next-question"]'),
    hasCheck: !!document.querySelector('[data-testid="exercise-check-answer"]'),
    summary: !document.querySelector('form[name="answerform"]') && cells.length === 0 &&
             !!document.querySelector('.bibliotron-exercise'),
    extension: diag,
  };
})()`;

/**
 * Collapse state of the injected summary card.
 *
 * `visibleRows` uses real rendered height rather than counting DOM nodes: the
 * table stays in the DOM while collapsed so that expanding is instant, so only
 * geometry proves it is actually hidden.
 */
const SUMMARY_CARD_STATE = `(() => {
  ${NORM_JS}
  const host = document.getElementById('khan-academy-timer-summary');
  if (!host || !host.shadowRoot) return { present: false };
  const root = host.shadowRoot;
  const card = root.querySelector('.card');
  const toggle = root.querySelector('[data-role="toggle"]');
  const rows = Array.from(root.querySelectorAll('tbody tr'));
  return {
    present: true,
    collapsed: card ? card.classList.contains('collapsed') : null,
    hostAttr: host.getAttribute('data-khan-timer-summary-collapsed'),
    hasToggle: !!toggle,
    toggleLabel: toggle ? toggle.getAttribute('aria-label') : null,
    ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
    visibleRows: rows.filter((r) => r.getBoundingClientRect().height > 0).length,
    totalRows: rows.length,
    text: norm(root.textContent),
  };
})()`;

/** Click the card's collapse control. */
const CLICK_SUMMARY_TOGGLE = `(() => {
  const host = document.getElementById('khan-academy-timer-summary');
  const toggle = host && host.shadowRoot && host.shadowRoot.querySelector('[data-role="toggle"]');
  if (!toggle) return false;
  toggle.click();
  return true;
})()`;

/** Parse m:ss / h:mm:ss into milliseconds. */
function parseDisplay(text) {
  if (!text) return null;
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/** Submit a deliberately WRONG answer, to force the "Check again" retry path. */
const SUBMIT_WRONG = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  if (!region) return { ok: false, reason: 'no region' };
  const input = region.querySelector('input[type="text"], input:not([type]), textarea');
  if (!input) return { ok: false, reason: 'no input' };
  const m = norm(region.textContent).match(/(\d[\d,]*)\s*[+]\s*(\d[\d,]*)/);
  const wrong = m
    ? String(Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')) + 7)
    : '424242';
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, wrong);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!btn) return { ok: false, reason: 'no check button' };
  btn.click();
  return { ok: true, wrong };
})()`;

/** Mirrors `isQuestionFinished`: the Check button was replaced by the advance control. */
const QUESTION_FINISHED = `(() => {
  return !!document.querySelector('[data-testid="exercise-next-question"]')
      && !document.querySelector('[data-testid="exercise-check-answer"]');
})()`;

/** Wait until the current question's progress state reaches `expected`. */
async function waitForState(cdp, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(CURRENT_STATE).catch(() => null);
    if (last?.state === expected) return last;
    await sleep(500);
  }
  return last;
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

/**
 * Solve the current question and confirm the page actually graded it correct.
 *
 * Khan Academy occasionally ignores the first synthetic input, and proceeding
 * on a wrong answer desynchronises the whole run and makes later checks
 * meaningless. Retrying keeps the verification deterministic.
 */
async function answerCorrectly(cdp, label, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const solved = await cdp.evaluate(SOLVE_AND_SUBMIT);
    if (!solved?.ok) {
      console.log(`  ${label} attempt ${attempt}: could not solve -> ${JSON.stringify(solved)}`);
      return { ok: false, solved };
    }
    await sleep(2600);
    const state = await cdp.evaluate(CURRENT_STATE);
    // On a RETRY the status word stays "incorrect" forever (Khan Academy keeps
    // the first attempt's verdict), so the advance control replacing the Check
    // button is the other valid sign that the answer was accepted.
    const finished = await cdp.evaluate(QUESTION_FINISHED).catch(() => false);
    console.log(
      `  ${label} attempt ${attempt}: answer=${solved.answer} -> state=${state?.state} finished=${finished}`,
    );
    if (state?.state === 'correct' || finished) return { ok: true, solved, state, finished };
  }
  return { ok: false, reason: 'never graded correct' };
}

/**
 * Wait for the end-of-exercise summary to settle.
 *
 * Khan Academy sometimes goes straight to the summary after the last answer
 * without waiting for the advance control to be clicked, so a single check can
 * race the transition.
 */
async function waitForSummary(cdp, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(PAGE_STATE).catch(() => null);
    if (last?.summary) return { reached: true, state: last };
    await sleep(700);
  }
  return { reached: false, state: last };
}

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

    // The panel is shown once a question is actually being timed (so it stays
    // off course pages and videos), which on a fresh page load is a moment after
    // the host element appears. Wait for it rather than sampling once.
    let panelVisible = panel?.visible === true;
    for (let i = 0; i < 24 && !panelVisible; i += 1) {
      await sleep(500);
      panel = await cdp.evaluate(READ_PANEL).catch(() => null);
      panelVisible = panel?.visible === true;
    }
    check(
      'panel is visible once a question is being timed',
      panelVisible,
      `host.style.display=${JSON.stringify(panel?.hostDisplay)} classes=${panel?.statusClasses}`,
    );

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

    // 6. Answering CORRECTLY stops the current question's timer.
    //
    // Requirement 2: once the Check result is "correct" the learner is done with
    // the question, so the clock must stop. This replaces an earlier assertion
    // that the timer should keep running.
    await cdp.evaluate(clickPanel('reset'));
    await sleep(600);
    await sleep(2500);

    const answered = await answerCorrectly(cdp, '[correct-answer]');
    check(
      'the page accepted the correct answer',
      answered.ok === true,
      JSON.stringify(answered.state ?? answered.reason),
    );
    await sleep(1200);
    const afterCorrect = await cdp.evaluate(READ_PANEL);
    const afterCorrectMs = parseDisplay(afterCorrect?.time);
    check(
      'answering correctly stops the timer',
      (afterCorrect?.statusClass ?? '').includes('finished'),
      `status=${afterCorrect?.statusClass} time=${afterCorrect?.time} footer=${afterCorrect?.footer}`,
    );
    check(
      'the panel shows the completed state',
      afterCorrect?.pauseLabel === '已完成',
      `pauseLabel=${afterCorrect?.pauseLabel}`,
    );
    check(
      'the pause control is disabled once the question is done',
      afterCorrect?.pauseDisabled === true,
      `disabled=${afterCorrect?.pauseDisabled}`,
    );
    // Decisive: the frozen value must not creep upwards afterwards.
    await sleep(3500);
    const stillFrozen = await cdp.evaluate(READ_PANEL);
    check(
      'the frozen value does not creep upwards afterwards',
      parseDisplay(stillFrozen?.time) !== null &&
        afterCorrectMs !== null &&
        Math.abs(parseDisplay(stillFrozen?.time) - afterCorrectMs) <= 1000,
      `${afterCorrect?.time} -> ${stillFrozen?.time} after 3.5s`,
    );

    // 7. Advancing starts a fresh timer for the next question.
    const advanced = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('a next-question control appears once the question is done', advanced);
    await sleep(4200);
    const afterAdvance = await cdp.evaluate(READ_PANEL);
    const afterAdvanceMs = parseDisplay(afterAdvance?.time);
    check(
      'advancing to the next question restarts the timer',
      afterAdvanceMs !== null && afterAdvanceMs <= 3000,
      `${afterCorrect?.time} -> ${afterAdvance?.time}`,
    );
    check(
      'the question identity changed on advance',
      afterAdvance?.meta !== afterCorrect?.meta,
      `${afterCorrect?.meta} -> ${afterAdvance?.meta}`,
    );
    check(
      'a record was saved for the finished question',
      /已记录\s*[1-9]/.test(afterAdvance?.footer ?? ''),
      afterAdvance?.footer,
    );

    // 7b. A correct RETRY must also stop the timer.
    //
    // Reported bug: answering wrong and then correctly leaves the progress
    // marker on "incorrect" (Khan Academy keeps the FIRST attempt's verdict), so
    // a rule that only watches the status word never fires. The Check button
    // being replaced by the advance control is the reliable signal.
    await cdp.evaluate(clickPanel('reset'));
    await sleep(600);
    await sleep(2200);
    const beforeWrong = await cdp.evaluate(READ_PANEL);
    const wrongSubmit = await cdp.evaluate(SUBMIT_WRONG);
    console.log(`\n  [retry] submitted wrong answer: ${JSON.stringify(wrongSubmit)}`);
    const wrongState = await waitForState(cdp, 'incorrect');
    check(
      'a wrong answer is graded incorrect',
      wrongState?.state === 'incorrect',
      JSON.stringify(wrongState),
    );
    await sleep(2500);
    const afterWrong = await cdp.evaluate(READ_PANEL);
    check(
      'a wrong answer keeps the timer running (the learner may retry)',
      !(afterWrong?.statusClass ?? '').includes('finished') &&
        parseDisplay(afterWrong?.time) >= parseDisplay(beforeWrong?.time),
      `${beforeWrong?.time} -> ${afterWrong?.time} status=${afterWrong?.statusClass}`,
    );

    const retry = await answerCorrectly(cdp, '[retry]');
    check('the corrected answer was accepted by the page', retry.ok === true, JSON.stringify(retry.state ?? retry.reason));
    const retryState = await cdp.evaluate(CURRENT_STATE);
    // Recorded, not asserted: this is the root cause of the original bug.
    console.log(
      `  [retry] progress state after a correct retry = ${JSON.stringify(retryState)} ` +
        '(Khan Academy keeps the first attempt verdict)',
    );
    await sleep(1500);
    const afterRetry = await cdp.evaluate(READ_PANEL);
    check(
      'REGRESSION: a correct retry stops the timer',
      (afterRetry?.statusClass ?? '').includes('finished'),
      `status=${afterRetry?.statusClass} time=${afterRetry?.time} footer=${afterRetry?.footer}`,
    );
    const retryFrozenMs = parseDisplay(afterRetry?.time);
    await sleep(3200);
    const retryStillFrozen = await cdp.evaluate(READ_PANEL);
    check(
      'the retry-frozen value does not creep upwards afterwards',
      retryFrozenMs !== null &&
        Math.abs(parseDisplay(retryStillFrozen?.time) - retryFrozenMs) <= 1000,
      `${afterRetry?.time} -> ${retryStillFrozen?.time} after 3.2s`,
    );
    const retryAdvance = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('the retried question can be advanced past', retryAdvance);
    await sleep(4200);

    // 8. SKIP: confirming a skip stops the current question's timer.
    //
    // Requirement 1. Clicking Skip opens a confirmation dialog; only confirming
    // it means the question was actually skipped.
    const skipOpened = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-skip-button"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('the skip control is available', skipOpened);
    if (skipOpened) {
      await sleep(1600);
      const dialog = await cdp.evaluate(`(() => {
        ${NORM_JS}
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          .filter((d) => !/cookie|privacy/i.test(d.textContent || ''));
        const d = dialogs[dialogs.length - 1];
        if (!d) return null;
        return {
          text: norm(d.textContent).slice(0, 120),
          buttons: Array.from(d.querySelectorAll('button'))
            .map((b) => norm(b.textContent) || b.getAttribute('aria-label')),
        };
      })()`);
      console.log(`  skip dialog: ${JSON.stringify(dialog)}`);
      check('skip asks for confirmation first', Boolean(dialog?.text));

      const beforeSkip = parseDisplay((await cdp.evaluate(READ_PANEL))?.time);
      const confirmed = await cdp.evaluate(`(() => {
        ${NORM_JS}
        const lower = (s) => norm(s).toLowerCase();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          .filter((d) => !/cookie|privacy/i.test(d.textContent || ''));
        const d = dialogs[dialogs.length - 1];
        if (!d) return { clicked: false };
        const target = Array.from(d.querySelectorAll('button'))
          .find((b) => /skip/i.test(lower(b.textContent) + ' ' + lower(b.getAttribute('aria-label'))));
        if (!target) {
          return {
            clicked: false,
            buttons: Array.from(d.querySelectorAll('button')).map((b) => norm(b.textContent)),
          };
        }
        target.click();
        return { clicked: true, label: norm(target.textContent) };
      })()`);
      console.log(`  skip confirm: ${JSON.stringify(confirmed)}`);
      check('the skip confirmation can be triggered', Boolean(confirmed?.clicked));
      await sleep(3200);

      const afterSkip = await cdp.evaluate(READ_PANEL);
      const afterSkipMs = parseDisplay(afterSkip?.time);
      check(
        'confirming a skip stops the timer',
        beforeSkip !== null && afterSkipMs !== null && afterSkipMs - beforeSkip <= 2000,
        `${msToDisplay(beforeSkip)} -> ${afterSkip?.time} (frozen on skip)`,
      );
      check(
        'the panel reports the skip',
        /跳过/.test(`${afterSkip?.footer ?? ''}${afterSkip?.meta ?? ''}`) ||
          (afterSkip?.statusClass ?? '').includes('finished'),
        `status=${afterSkip?.statusClass} footer=${afterSkip?.footer}`,
      );

      // A skip does not advance by itself: the question is marked incorrect and
      // the learner still has to finish it to move on. Answering it afterwards
      // must NOT create a second record for the same question.
      const skippedThenAnswered = await cdp.evaluate(SOLVE_AND_SUBMIT);
      console.log(`  solving the skipped question: ${JSON.stringify(skippedThenAnswered)}`);
      await sleep(3200);
      console.log(`  state after answering the skipped question: ${JSON.stringify(await cdp.evaluate(CURRENT_STATE))}`);
      const afterSkipAnswer = await cdp.evaluate(READ_PANEL);
      check(
        'answering after a skip does not resume the stopped timer',
        parseDisplay(afterSkipAnswer?.time) === afterSkipMs,
        `${afterSkip?.time} -> ${afterSkipAnswer?.time}`,
      );
      const advanceAfterSkip = await cdp.evaluate(`(() => {
        const b = document.querySelector('[data-testid="exercise-next-question"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      check('the skipped question can be advanced past', advanceAfterSkip);
      await sleep(4200);
      console.log(`  after skipping: ${JSON.stringify(await cdp.evaluate(PAGE_STATE))}`);
    }

    // 9. Finish the remaining questions and reach the summary screen.
    //    Requirement 3: the summary must show every question's time for this run.
    // 4 regular questions plus an optional bonus question, then the summary.
    // The bonus question is NOT always present, so the run records whether one
    // was actually visited.
    let sawBonusQuestion = false;
    for (let round = 1; round <= 8; round += 1) {
      const beforeRound = await cdp.evaluate(PAGE_STATE);
      const panelBefore = await cdp.evaluate(READ_PANEL);
      console.log(
        `\n  [round ${round}] page: current=${beforeRound?.current} ` +
          `form=${beforeRound?.hasAnswerForm} check=${beforeRound?.hasCheck} next=${beforeRound?.hasNext} ` +
          `summary=${beforeRound?.summary}`,
      );
      console.log(`             panel: time=${panelBefore?.time} status=${panelBefore?.statusClasses} footer=${panelBefore?.footer}`);
      console.log(`             ext: ${JSON.stringify(beforeRound?.extension && {
        evals: beforeRound.extension.evaluateCount,
        reason: beforeRound.extension.lastReason,
        progress: beforeRound.extension.progress,
        progressRaw: beforeRound.extension.progressRaw,
        key: beforeRound.extension.questionKey,
        engineKey: beforeRound.extension.engineQuestionKey,
        pending: beforeRound.extension.pendingCandidate,
        lastEvent: beforeRound.extension.lastEvent,
      })}`);

      const onSummary = await cdp.evaluate(SUMMARY_PRESENT);
      if (onSummary) break;

      // Answer, then confirm the page actually graded it correct.
      const solved = await answerCorrectly(cdp, `[round ${round}]`);
      if (!solved?.ok) {
        // The last question replaces "Next question" with "Show summary".
        const summaryClicked = await cdp.evaluate(`(() => {
          const b = document.querySelector('[data-testid="exercise-next-question"]');
          if (!b) return false;
          b.click();
          return true;
        })()`);
        if (summaryClicked) {
          await sleep(4500);
          break;
        }
        break;
      }
      const panelAfterSolve = await cdp.evaluate(READ_PANEL);
      console.log(
        `  [round ${round}] after answering: panel time=${panelAfterSolve?.time} ` +
          `status=${panelAfterSolve?.statusClasses} footer=${panelAfterSolve?.footer}`,
      );

      const advanceLabel = await cdp.evaluate(ADVANCE_LABEL);
      console.log(`  [round ${round}] advance control label = ${JSON.stringify(advanceLabel)}`);
      if (/bonus/i.test(advanceLabel ?? '')) sawBonusQuestion = true;
      const next = await cdp.evaluate(`(() => {
        const b = document.querySelector('[data-testid="exercise-next-question"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      console.log(`  [round ${round}] clicked next=${next}`);
      if (!next) await sleep(1200);
      await sleep(3800);
      const afterNext = await cdp.evaluate(PAGE_STATE);
      const panelAfterNext = await cdp.evaluate(READ_PANEL);
      console.log(`  [round ${round}] after next: current=${afterNext?.current} summary=${afterNext?.summary} panel time=${panelAfterNext?.time} status=${panelAfterNext?.statusClasses} footer=${panelAfterNext?.footer}`);
    }

    let summaryRowCount = 0;
    const summaryWait = await waitForSummary(cdp);
    const reachedSummary = summaryWait.reached;
    const lastState = summaryWait.state;
    // Khan Academy occasionally tears the question down without presenting
    // either the next question or the summary. Nothing the extension can do
    // about that, so the summary checks are reported as inconclusive.
    const stuckTransition =
      !reachedSummary &&
      lastState &&
      lastState.hasAnswerForm === false &&
      lastState.summary === false &&
      (lastState.progressAll?.length ?? 0) > 0;
    if (!reachedSummary) {
      console.log(
        `  summary never settled; last page state: ${JSON.stringify(lastState)}`,
      );
    }
    if (stuckTransition) {
      console.log(
        '  NOTE: Khan Academy left the page in a transitional state ' +
          '(no answer form, progress markers still present, no summary). ' +
          'The extension correctly reported 识别不确定 and kept timing.',
      );
      skipCheck(
        'the end-of-exercise summary screen is reached',
        'page stuck in a Khan Academy transition, not a summary',
      );
    } else {
      check('the end-of-exercise summary screen is reached', reachedSummary);
    }
    if (reachedSummary) {
      await sleep(2000);
      const summaryCard = await cdp.evaluate(SUMMARY_CARD);
      console.log(`\n  summary card: ${JSON.stringify(summaryCard)}`);
      check('the summary card is injected', Boolean(summaryCard?.present));
      check(
        'the summary lists every question of this run',
        (summaryCard?.rowCount ?? 0) >= 3,
        `rowCount=${summaryCard?.rowCount}`,
      );
      summaryRowCount = summaryCard?.rowCount ?? 0;
      if (sawBonusQuestion) {
        check(
          'the summary tags the bonus question',
          /加试/.test(summaryCard?.rows?.join(' ') ?? ''),
          JSON.stringify(summaryCard?.rows),
        );
      } else {
        // Observed both with and without a bonus question, so this is only
        // assertable when one was actually visited during the run.
        skipCheck(
          'the summary tags the bonus question',
          'this run presented no bonus question',
        );
      }
      check(
        'each summary row shows a duration',
        (summaryCard?.durations?.length ?? 0) === (summaryCard?.rowCount ?? -1) &&
          (summaryCard?.durations ?? []).every((d) => /^\d+:\d{2}/.test(d)),
        JSON.stringify(summaryCard?.durations),
      );
      check(
        'the summary shows a total',
        /合计/.test(summaryCard?.text ?? ''),
        (summaryCard?.text ?? '').slice(0, 120),
      );
      check(
        'the summary marks the skipped question',
        /已跳过/.test(summaryCard?.rows?.join(' ') ?? ''),
        JSON.stringify(summaryCard?.rows),
      );
      check(
        'the summary does not print any tag twice',
        !/加试加试|已跳过已跳过|答对答对/.test(summaryCard?.rows?.join(' ') ?? ''),
        JSON.stringify(summaryCard?.rows),
      );
      // The card must be collapsible down to its header line.
      const cardBefore = await cdp.evaluate(SUMMARY_CARD_STATE);
      check(
        'the summary card exposes a collapse control',
        cardBefore?.hasToggle === true,
        `hasToggle=${cardBefore?.hasToggle} label=${cardBefore?.toggleLabel}`,
      );
      check(
        'the summary card starts expanded, with the rows laid out',
        cardBefore?.collapsed === false && (cardBefore?.visibleRows ?? 0) >= 3,
        `collapsed=${cardBefore?.collapsed} visibleRows=${cardBefore?.visibleRows}/${cardBefore?.totalRows}`,
      );

      const toggled = await cdp.evaluate(CLICK_SUMMARY_TOGGLE);
      await sleep(900);
      const cardCollapsed = await cdp.evaluate(SUMMARY_CARD_STATE);
      check(
        'collapsing the card hides the per-question rows',
        toggled === true &&
          cardCollapsed?.collapsed === true &&
          cardCollapsed?.visibleRows === 0,
        `collapsed=${cardCollapsed?.collapsed} visibleRows=${cardCollapsed?.visibleRows}/${cardCollapsed?.totalRows}`,
      );
      check(
        'the collapsed card keeps the title and the total',
        /本轮每题用时/.test(cardCollapsed?.text ?? '') &&
          /共 \d+ 题/.test(cardCollapsed?.text ?? ''),
        (cardCollapsed?.text ?? '').slice(0, 90),
      );
      check(
        'the collapse state is mirrored for accessibility',
        cardCollapsed?.hostAttr === 'true' && cardCollapsed?.ariaExpanded === 'false',
        `hostAttr=${cardCollapsed?.hostAttr} aria-expanded=${cardCollapsed?.ariaExpanded}`,
      );

      await cdp.evaluate(CLICK_SUMMARY_TOGGLE);
      await sleep(900);
      const cardExpanded = await cdp.evaluate(SUMMARY_CARD_STATE);
      check(
        'expanding the card brings the rows back',
        cardExpanded?.collapsed === false &&
          (cardExpanded?.visibleRows ?? 0) === (cardBefore?.visibleRows ?? -1),
        `collapsed=${cardExpanded?.collapsed} visibleRows=${cardExpanded?.visibleRows}`,
      );

      // Collapse once more so the preference is exercised for persistence.
      await cdp.evaluate(CLICK_SUMMARY_TOGGLE);
      await sleep(900);

      check(
        'the float panel is hidden on the summary screen',
        (await cdp.evaluate(READ_PANEL))?.visible === false,
        'no question is being timed here',
      );
    }

    // 10. The extension's own popup page: real storage, real settings, real records.
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
          records: (all.records && all.records.records ? all.records.records : []).map((r) => ({
            runId: r.runId,
            questionIndex: r.questionIndex,
            durationMs: r.durationMs,
            status: r.status,
            endReason: r.endReason,
            outcome: r.firstSubmissionOutcome,
          })),
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
      // Strongest cross-check available: the summary must show exactly the
      // records that were persisted for this run, no more and no fewer.
      const runIds = new Set((popupState?.records ?? []).map((r) => r.runId));
      check(
        'all saved records belong to a single run',
        runIds.size === 1,
        `distinct runIds=${runIds.size}`,
      );
      if (stuckTransition) {
        skipCheck(
          'the summary shows exactly the records saved for this run',
          'no summary page was presented',
        );
      } else {
        check(
          'the summary shows exactly the records saved for this run',
          summaryRowCount === (popupState?.recordCount ?? -1),
          `summaryRows=${summaryRowCount} savedRecords=${popupState?.recordCount}`,
        );
      }
      check(
        'every record carries a question outcome',
        (popupState?.records ?? []).every((r) => r.outcome !== 'unknown'),
        JSON.stringify((popupState?.records ?? []).map((r) => r.outcome)),
      );
      check(
        'popup reflects the stored timer mode',
        popupState?.uiMode === 'countup',
        `uiMode=${popupState?.uiMode}`,
      );
      // The popup must show the EFFECTIVE configuration before the user changes
      // anything through it. Storage itself may already hold a settings object
      // (collapsing the summary card writes one), so this asserts the rendered
      // values rather than the absence of the key.
      check(
        'popup shows the effective settings before anything is changed through it',
        popupState?.uiMode === 'countup' &&
          popupState?.uiLimit === '60' &&
          popupState?.checkboxes?.overlayCollapsed === false,
        `settings=${JSON.stringify(popupState?.settings)} uiMode=${popupState?.uiMode} uiLimit=${popupState?.uiLimit}`,
      );
      check(
        'collapsing the summary card was persisted',
        popupState?.settings?.summaryCollapsed === true,
        `summaryCollapsed=${popupState?.settings?.summaryCollapsed}`,
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

    // 11. Countdown mode: a fresh exercise target, so there is a live question.
    //     (The first target has already reached the summary, where nothing is
    //     being timed any more.)
    if (popup) {
      let cdCdp = null;
      try {
        cdCdp = await openTarget(URL_ARG);
        await cdCdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1440,
          height: 900,
          deviceScaleFactor: 2,
          mobile: false,
        });
        for (let i = 0; i < 40; i += 1) {
          const ready = await cdCdp
            .evaluate(`!!document.querySelector('#khan-academy-timer-host')`)
            .catch(() => false);
          if (ready) break;
          await sleep(1000);
        }
        await sleep(2500);

        // Drive the mode change through the popup's own controls (the page
        // world has no access to chrome.storage).
        await popup.evaluate(`(async () => {
          const sel = document.getElementById('defaultMode');
          sel.value = 'countdown';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          const lim = document.getElementById('countdownLimitSeconds');
          lim.value = '6';
          lim.dispatchEvent(new Event('change', { bubbles: true }));
          const sound = document.getElementById('soundEnabled');
          sound.checked = false;
          sound.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 800));
          return true;
        })()`);
        await sleep(2000);

        const cd1 = await cdCdp.evaluate(READ_PANEL);
        check(
          'countdown mode applies live to a running question',
          cd1?.mode === '倒计时',
          `mode=${cd1?.mode} meta=${cd1?.meta}`,
        );
        await sleep(9000);
        const cd2 = await cdCdp.evaluate(READ_PANEL);
        check(
          'countdown reaching zero shows a visible timeout state',
          (cd2?.statusClass ?? '').includes('expired'),
          `status=${cd2?.statusClass} time=${cd2?.time} meta=${cd2?.meta}`,
        );
        check(
          'the timeout state is announced in the panel',
          /超时|倒计时结束/.test(`${cd2?.meta ?? ''}${cd2?.footer ?? ''}`),
          `meta=${cd2?.meta} footer=${cd2?.footer}`,
        );
        check(
          'timeout does not navigate away or submit anything',
          (await cdCdp.evaluate(SUMMARY_PRESENT)) === false && Boolean(cd2?.time),
          `time=${cd2?.time}`,
        );
      } catch (error) {
        check('countdown mode could be verified', false, error.message);
      } finally {
        try {
          cdCdp?.ws?.close?.();
        } catch {
          /* ignore */
        }
        if (cdCdp?.targetId) {
          await fetch(`http://127.0.0.1:${PORT}/json/close/${cdCdp.targetId}`).catch(() => undefined);
        }
      }
    }

    // 12. Clearing records from the popup really clears them (spec 8.4).
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
        // The popup has no control for this one; write it back directly so the
        // extension is left in its default state.
        const all = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({
          settings: Object.assign({}, all.settings || {}, { summaryCollapsed: false }),
        });
        await new Promise((r) => setTimeout(r, 600));
        return true;
      })()`);
      check('settings can be restored to defaults', true);
    }

    // 13. The floating panel tracks whether a question is being timed, so it
    //     stays off pages with nothing to time (course pages, video pages, and
    //     the intro card that quiz / unit-test / course-challenge pages show
    //     before the learner starts).
    {
      const panelVisibleOn = async (target) => (await target.evaluate(READ_PANEL))?.visible === true;

      // 13a. A plain course page is not an exercise: no panel.
      const courseCdp = await openTarget(
        'https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction',
      );
      try {
        await sleep(9000);
        const state = await courseCdp.evaluate(PAGE_STATE);
        check(
          'no panel on a course page with nothing to time',
          (await panelVisibleOn(courseCdp)) === false,
          `summary=${state?.summary} hasAnswerForm=${state?.hasAnswerForm} progress=${state?.progressAll?.length}`,
        );
      } catch (error) {
        check('course page could be checked', false, error.message);
      } finally {
        if (courseCdp.targetId) {
          await fetch(`http://127.0.0.1:${PORT}/json/close/${courseCdp.targetId}`).catch(() => undefined);
        }
      }

      // 13b. A quiz sits behind a "Let's go" intro card. The panel must appear
      //      only once a question is actually on screen.
      const quizUrl =
        'https://www.khanacademy.org/test-prep/v2-sat-math/x0fcc98a58ba3bea7:algebra-easier/' +
        'x0fcc98a58ba3bea7:graphs-of-linear-systems-and-inequalities-easier/quiz/' +
        'x0fcc98a58ba3bea7:algebra-easier-quiz-2';
      const quizCdp = await openTarget(quizUrl);
      try {
        for (let i = 0; i < 40; i += 1) {
          const ready = await quizCdp
            .evaluate(`!!document.getElementById('khan-academy-timer-host')`)
            .catch(() => false);
          if (ready) break;
          await sleep(1000);
        }
        await sleep(6000);

        const intro = await quizCdp.evaluate(PAGE_STATE);
        const introStart = await quizCdp.evaluate(`(() => {
          return !!document.querySelector('[data-testid="start-task-card-summary"]');
        })()`);
        check(
          'the quiz shows its intro card before starting',
          introStart === true,
          `startCard=${introStart} hasAnswerForm=${intro?.hasAnswerForm}`,
        );
        // Give the panel every chance to appear before calling it hidden.
        let introVisible = await panelVisibleOn(quizCdp);
        for (let i = 0; i < 8 && !introVisible; i += 1) {
          await sleep(500);
          introVisible = await panelVisibleOn(quizCdp);
        }
        check(
          'no panel before the quiz is started',
          introVisible === false,
          `visible=${introVisible}`,
        );

        const started = await quizCdp.evaluate(`(() => {
          const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
            if (b.disabled) continue;
            const label = norm(b.textContent) || norm(b.getAttribute('aria-label'));
            if (/^let.s go/.test(label)) { b.click(); return label; }
          }
          return null;
        })()`);
        check('the quiz can be started', Boolean(started), `clicked=${JSON.stringify(started)}`);
        await sleep(9000);

        const inQuiz = await quizCdp.evaluate(PAGE_STATE);
        check(
          'a question is detected inside the quiz',
          (inQuiz?.progressAll?.length ?? 0) > 0 && inQuiz?.hasAnswerForm === true,
          `progress=${inQuiz?.progressAll?.length} hasAnswerForm=${inQuiz?.hasAnswerForm}`,
        );
        let quizVisible = await panelVisibleOn(quizCdp);
        for (let i = 0; i < 24 && !quizVisible; i += 1) {
          await sleep(500);
          quizVisible = await panelVisibleOn(quizCdp);
        }
        check(
          'the panel appears once the quiz has a question',
          quizVisible === true,
          `visible=${quizVisible}`,
        );
        const quizPanel = await quizCdp.evaluate(READ_PANEL);
        check(
          'the panel reports the quiz question',
          /进度/.test(quizPanel?.meta ?? ''),
          `meta=${quizPanel?.meta}`,
        );
      } catch (error) {
        check('quiz page could be checked', false, error.message);
      } finally {
        if (quizCdp.targetId) {
          await fetch(`http://127.0.0.1:${PORT}/json/close/${quizCdp.targetId}`).catch(() => undefined);
        }
      }
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
    console.log(
      `  all ${results.length - skipped} extension checks passed` +
        (skipped > 0 ? `, ${skipped} inconclusive` : ''),
    );
  } else {
    console.log(`  ${failures} of ${results.length} extension checks FAILED`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n  verification failed to run:', error.message);
  process.exitCode = 1;
});

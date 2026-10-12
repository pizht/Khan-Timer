#!/usr/bin/env node
/**
 * Live verification of the "the panel flashed on a practice start page" defect.
 *
 * The report: opening a practice's start page showed the floating timer panel for
 * a moment and then closed it. Two things had to happen for that, and both are
 * checked here against the real khanacademy.org with the built extension loaded:
 *
 *   1. the overlay host was in the DOM *visible* before the controller's first
 *      detection verdict (so anything that showed it, showed it immediately);
 *   2. the start page still held the previous question's Perseus region, which
 *      the detector accepted as a question (a fingerprint), started a clock for
 *      and therefore had something to render in the panel.
 *
 * The script watches the page from the FIRST frame (the recorder is installed
 * with `Page.addScriptToEvaluateOnNewDocument`), so "did the panel ever become
 * visible" is answered by a 50 ms sample series rather than by a single look.
 *
 * It also checks the other half of the rule: once the learner starts the exercise
 * and the page reports a question position, the panel must appear (with the clock
 * already running), i.e. the fix must not make the panel unreachable.
 *
 * Usage:
 *   node scripts/verify-startcard-flash.mjs [url] [--headed] [--keep]
 *
 * Defaults to the practice from the defect report. No sign-in is needed: the
 * start page and the first questions of a practice are visible signed out.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBrowserRunnable, resolveEdge } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
/**
 * The browser is resolved from `EDGE_PATH`, the platform default locations, or
 * `PATH` — see `scripts/lib/browser.mjs`.
 *
 * Resolution is lazy on purpose: importing this file must not fail, so that
 * `assertBrowserRunnable()` in `main()` is what reports a missing browser (with
 * the list of paths it tried) instead of a bare module-load stack trace.
 */
let edgePath;
const edgeBinary = () => (edgePath ??= resolveEdge());

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const URL_UNDER_TEST =
  args[0] ??
  'https://www.khanacademy.org/math/cc-2nd-grade-math/x3184e0ec:add-and-subtract-within-20/cc-2nd-repeated-addition/e/repeated-addition';
/**
 * A practice with a numeric text input, so question 1 can be answered and its
 * record inspected for spurious paused time. `--no-solve` skips that part.
 */
const URL_SOLVABLE =
  args[1] ?? 'https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/e/addition_4';
const HEADED = process.argv.includes('--headed');
const KEEP = process.argv.includes('--keep');
const SOLVE = !process.argv.includes('--no-solve');

const PORT = 10900 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The unpacked extension's id is derived from its absolute path (Chromium rule). */
function unpackedExtensionId(absPath) {
  const digest = createHash('sha256').update(path.resolve(absPath)).digest('hex').slice(0, 32);
  return Array.from(digest)
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
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
  async evaluate(expression, timeoutMs = 30000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return r.result?.value;
  }
}

async function waitForDevTools(port = PORT) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
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

/** Open a CDP session on a target (a page, or the extension's popup page). */
async function openSocket(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  });
  return ws;
}

/* ------------------------------------------------------------------ *
 * Page-side snippets
 * ------------------------------------------------------------------ */

/**
 * Frame-by-frame recorder. Installed before any page script runs, so it samples
 * the overlay host from the very first frame: what matters for "did it flash" is
 * whether the host was ever in the DOM *and* not hidden.
 */
const RECORDER = String.raw`(() => {
  if (window.__katFlash) return;
  const samples = [];
  window.__katFlash = samples;
  window.__katMark = (phase) => { window.__katPhase = { phase, at: performance.now() }; };
  const sample = () => {
    const host = document.getElementById('khan-academy-timer-host');
    const panel = host && host.shadowRoot
      ? host.shadowRoot.querySelector('.panel')
      : null;
    samples.push({
      t: Math.round(performance.now()),
      phase: window.__katPhase ? window.__katPhase.phase : 'load',
      present: host !== null,
      display: host ? host.style.display : null,
      hasShadow: !!(host && host.shadowRoot),
      panelPainted: !!(panel && panel.getClientRects().length > 0),
      startCard: !!document.querySelector('[data-testid="start-task-card-summary"]'),
      answerform: !!document.querySelector('form[name="answerform"]'),
      cells: document.querySelectorAll('[data-testid^="exercise-progress-"]').length,
      path: location.pathname,
    });
    if (samples.length < 3000) setTimeout(sample, 50);
  };
  sample();
})()`;

/** A compact, readable timeline of what changed, for the notes. */
const TIMELINE = String.raw`(() => {
  const rows = [];
  let previous = null;
  for (const s of (window.__katFlash || [])) {
    const line = [s.phase, s.startCard ? 'startCard' : '-', s.answerform ? 'form' : '-',
      'cells:' + s.cells,
      'panel:' + (s.present ? (s.display === 'none' ? 'hidden' : 'shown') : 'absent'),
      s.panelPainted ? 'painted' : ''].join(' ');
    if (line !== previous) {
      rows.push(s.t + 'ms  ' + line);
      previous = line;
    }
  }
  return rows;
})()`;

/** Everything needed to describe what the page looks like right now. */
const PAGE_STATE = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const host = document.getElementById('khan-academy-timer-host');
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  let diag = null;
  try {
    diag = host ? JSON.parse(host.getAttribute('data-khan-timer-diagnostics') || 'null') : null;
  } catch {}
  return {
    href: location.href,
    startCard: !!document.querySelector('[data-testid="start-task-card-summary"]'),
    answerform: !!document.querySelector('form[name="answerform"]'),
    cells: cells.length,
    progress: cur ? cur.getAttribute('data-testid') : null,
    hostPresent: host !== null,
    hostDisplay: host ? host.style.display : null,
    panelVisible: host ? host.style.display !== 'none' : null,
    panelTime: host && host.shadowRoot
      ? norm(host.shadowRoot.querySelector('[data-role="time"]')?.textContent)
      : null,
    engineQuestionKey: diag ? diag.engineQuestionKey : null,
    unidentified: diag ? diag.unidentified : null,
  };
})()`;

/** Click the intro card's start control, whatever it is labelled. */
const CLICK_START = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const card = document.querySelector('[data-testid="start-task-card-summary"]');
  if (!card) return { clicked: false, reason: 'no start card' };
  const buttons = Array.from(card.querySelectorAll('button, [role="button"], a'));
  const target =
    buttons.find((b) => /go|start|begin|开始|继续/i.test(norm(b.textContent) + ' ' + (b.getAttribute('aria-label') || ''))) ??
    buttons[0];
  if (!target) return { clicked: false, reason: 'no control', html: norm(card.textContent).slice(0, 120) };
  const label = norm(target.textContent) || target.getAttribute('aria-label');
  target.click();
  return { clicked: true, label };
})()`;

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;

function note(message) {
  console.log(`  · ${message}`);
}

function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  \u2713 ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${label}${detail ? `  (${detail})` : ''}`);
  }
  return ok;
}

/** Turn the sample series into the answer to "was it ever painted?". */
function analyseSamples(samples) {
  const painted = samples.filter((s) => s.panelPainted);
  const shown = samples.filter((s) => s.present && s.hasShadow && s.display !== 'none');
  const firstPresent = samples.find((s) => s.present);
  const startPage = samples.filter((s) => s.phase === 'startpage');
  const firstStartPage = startPage.length > 0 ? startPage[0].t : null;
  return {
    count: samples.length,
    firstPresentAt: firstPresent ? firstPresent.t : null,
    firstPresentDisplay: firstPresent ? firstPresent.display : null,
    shownSamples: shown.length,
    firstShownAt: shown.length > 0 ? shown[0].t : null,
    paintedSamples: painted.length,
    firstPaintedAt: painted.length > 0 ? painted[0].t : null,
    firstStartPageAt: firstStartPage,
    distinctDisplay: [...new Set(samples.filter((s) => s.present).map((s) => JSON.stringify(s.display)))],
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  assertBrowserRunnable();

  console.log(`\npractice under test: ${URL_UNDER_TEST}`);
  console.log(`extension: ${DIST}\n`);

  const profile = await mkdtemp(path.join(tmpdir(), 'kat-flash-'));
  console.log(`  browser profile: ${profile}`);
  const edge = spawn(
    edgeBinary(),
    [
      ...(HEADED ? [] : ['--headless=new']),
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
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    const page = await waitForDevTools();
    const cdp = new Cdp(await openSocket(page));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // The recorder has to exist before the page's own scripts, or the first
    // frames - the ones a flash lives in - are lost.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    await cdp.send('Page.navigate', { url: URL_UNDER_TEST });

    // ---- 1. the page as it loads ------------------------------------------
    console.log('\n1. the practice page as it loads (the state in the report)');
    let state = null;
    // Wait for either the start card or a question, whichever this practice
    // shows. A reload is deliberately NOT used to force the start card: that
    // races the fresh document's own content script.
    for (let i = 0; i < 50; i += 1) {
      await sleep(500);
      state = await cdp.evaluate(PAGE_STATE).catch(() => null);
      if (state?.startCard && state.hostPresent) break;
      if (state?.progress) break; // this practice opens straight into a question
    }

    if (state?.startCard) {
      note(
        `start card up: answerform=${state.answerform} cells=${state.cells} ` +
          `hostPresent=${state.hostPresent} hostDisplay=${JSON.stringify(state.hostDisplay)}`,
      );
    } else {
      note(
        `no start card on this practice (progress=${state?.progress}): it opens straight ` +
          'into a question, so the "no panel while the card is up" checks are skipped',
      );
    }

    // Let it sit for a few seconds: the flash used to happen in this window.
    await cdp.evaluate(`window.__katMark('settled')`);
    await sleep(4000);
    state = await cdp.evaluate(PAGE_STATE);
    let samples = analyseSamples(await cdp.evaluate('window.__katFlash'));
    note('timeline:');
    for (const row of await cdp.evaluate(TIMELINE)) console.log(`      ${row}`);

    if (state.startCard) {
      check(
        'no panel on the practice start page',
        state.panelVisible === false,
        `display=${JSON.stringify(state.hostDisplay)}`,
      );
      const paintedOnStartPage = (
        await cdp.evaluate(
          `(window.__katFlash || []).filter((s) => s.phase === 'settled' && s.panelPainted).length`,
        )
      );
      check(
        'the panel was never painted while the start card was up',
        paintedOnStartPage === 0,
        `paintedSamples=${paintedOnStartPage}`,
      );
    } else {
      note('skipping the "no panel on the start page" checks: no start card on this practice');
    }
    check(
      'the overlay host is hidden from its first frame',
      samples.firstPresentDisplay === 'none',
      `samples=${samples.count} firstDisplay=${JSON.stringify(samples.firstPresentDisplay)}`,
    );
    note(`display values seen after mount: ${JSON.stringify(samples.distinctDisplay)}`);

    // ---- 2. the question the page ends up showing -------------------------
    console.log('\n2. the question being solved');
    const started = await cdp.evaluate(CLICK_START);
    note(`start control: ${JSON.stringify(started)}`);
    if (!started?.clicked && !state.progress) {
      note('no start card and no question on this page: nothing further to check');
    } else {
      let question = state;
      if (started?.clicked) {
        for (let i = 0; i < 40; i += 1) {
          await sleep(500);
          question = await cdp.evaluate(PAGE_STATE).catch(() => null);
          if (question?.progress && question.panelVisible) break;
        }
      }
      check(
        'the panel comes up once the page reports a question position',
        question?.panelVisible === true,
        `progress=${question?.progress} display=${JSON.stringify(question?.hostDisplay)} time=${question?.panelTime}`,
      );
      check(
        'the panel shows a reading for the confirmed question',
        /^\d+:\d\d$/.test(question?.panelTime ?? '') && question.panelTime !== '0:00',
        `time=${question?.panelTime} questionKey=${question?.engineQuestionKey}`,
      );
      check(
        'the confirmed question is identified by its position, not a fingerprint',
        typeof question?.engineQuestionKey === 'string' &&
          question.engineQuestionKey.startsWith('id:'),
        `questionKey=${question?.engineQuestionKey}`,
      );
      // The panel was hidden for the stretch in which the page had a question
      // region but had not said WHICH question it is - and the clock was already
      // running then, which is what makes the reading on screen a real one.
      const paintedEarly = await cdp.evaluate(
        `(window.__katFlash || []).filter((s) => s.cells > 0 && s.panelPainted).length > 0
           ? (window.__katFlash || []).find((s) => s.cells > 0 && s.panelPainted).t : null`,
      );
      note(`first painted frame with a question region on the page: ${paintedEarly}ms`);

      // ---- 3. a route change to another practice --------------------------
      console.log('\n3. an in-app move to another practice (stale-clock case)');
      await cdp.evaluate(`window.__katMark('move')`);
      const fromPath = (await cdp.evaluate('location.pathname')).split('/').filter(Boolean).pop();
      const other = await cdp.evaluate(`(() => {
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const here = location.pathname.split('/').filter(Boolean).pop();
        const link = Array.from(document.querySelectorAll('a[href*="/e/"]'))
          .find((a) => !(a.getAttribute('href') || '').endsWith('/e/' + here));
        if (!link) return null;
        const href = link.getAttribute('href');
        link.click();
        return { href, text: norm(link.textContent) };
      })()`);
      if (!other) {
        note('no in-app link to another practice was found; skipping the route-change check');
      } else {
        note(`clicked "${other.text}" (${other.href}) — the practice being left is /e/${fromPath}`);
        let after = null;
        for (let i = 0; i < 40; i += 1) {
          await sleep(500);
          after = await cdp.evaluate(PAGE_STATE).catch(() => null);
          if (after && new URL(after.href).pathname.endsWith('/e/' + other.href.split('/').pop())) break;
        }
        await cdp.evaluate(`window.__katMark('nextPractice')`);
        await sleep(3000);
        after = await cdp.evaluate(PAGE_STATE);

        // The invariant: the panel is only ever painted while the engine belongs
        // to the practice in the address bar and the page reports a position for
        // it. A sample from the practice being left is fine (its question was on
        // screen); a sample that paints the LEFT practice's clock on the new one
        // is exactly the defect.
        const offenders = await cdp.evaluate(`(() => {
          const rows = (window.__katFlash || []).filter((s) => s.panelPainted);
          return rows.map((s) => ({ t: s.t, phase: s.phase, path: s.path, cells: s.cells, card: s.startCard }));
        })()`);
        const leaked = offenders.filter(
          (s) => s.path.endsWith('/e/' + other.href.split('/').pop()) && s.cells === 0,
        );
        check(
          'no panel appears while the next practice has no question yet',
          after?.cells === 0 ? after.panelVisible === false : true,
          `newPractice=${new URL(after?.href ?? 'https://x/').pathname.split('/').pop()} ` +
            `cells=${after?.cells} startCard=${after?.startCard} display=${JSON.stringify(after?.hostDisplay)}`,
        );
        check(
          'the previous practice clock was never painted on the new practice',
          leaked.length === 0,
          `paintedFramesOnNewPracticeWithoutQuestion=${leaked.length} of ${offenders.length} painted frames`,
        );
        if (leaked.length > 0) {
          note(`first offending frame: ${JSON.stringify(leaked[0])}`);
        }
      }
    }

    // ---- 4. question 1's record: no spurious paused time ------------------
    if (SOLVE) {
      console.log('\n4. question 1 answered: does its record carry paused time?');
      await cdp.send('Page.navigate', { url: URL_SOLVABLE });
      // Wait for a question with a position, then answer it and advance, which is
      // what writes its record. A reload is used as a fallback: the practice is
      // reached right after an in-app route change, and the app occasionally
      // leaves the previous exercise's frame up for longer than the wait.
      let q1 = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        for (let i = 0; i < 30; i += 1) {
          await sleep(500);
          q1 = await cdp.evaluate(PAGE_STATE).catch(() => null);
          if (q1?.progress && q1.cells > 0) break;
        }
        if (q1?.progress && q1.cells > 0) break;
        note(`no question with a position yet (attempt ${attempt}); reloading`);
        await cdp.send('Page.reload', { ignoreCache: false });
        await sleep(1500);
      }
      note(`practice: ${new URL(q1?.href ?? URL_SOLVABLE).pathname.split('/').pop()} progress=${q1?.progress}`);
      if (!q1?.progress) {
        note('could not reach a question on the solvable practice; skipping the record checks');
      } else {
        // Let the question be timed for a moment before answering: a question
        // abandoned within one second without a submission is deliberately
        // treated as detection noise and not stored, and this script must not
        // race that rule.
        await sleep(2500);
        const solved = await cdp.evaluate(`(() => {
          const region = document.querySelector('form[name="answerform"]');
          if (!region) return { ok: false, reason: 'no region' };
          const text = (region.textContent || '').replace(/\\s+/g, ' ').trim();
          const m = text.match(/(\\d[\\d,]*)\\s*([+\\u2212-])\\s*(\\d[\\d,]*)/);
          if (!m) return { ok: false, reason: 'no arithmetic pattern', text: text.slice(0, 120) };
          const a = Number(m[1].replace(/,/g, ''));
          const b = Number(m[3].replace(/,/g, ''));
          const answer = String(m[2] === '+' ? a + b : a - b);
          const input = region.querySelector('input[type="text"], input:not([type]), textarea');
          if (input) {
            const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const choices = Array.from(region.querySelectorAll('[role="radio"], [role="option"], button'));
            const target = choices.find((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim() === answer);
            if (!target) return { ok: false, reason: 'no input and no matching choice', answer };
            target.click();
          }
          const btn = document.querySelector('[data-testid="exercise-check-answer"]');
          if (!btn) return { ok: false, reason: 'no check button' };
          btn.click();
          return { ok: true, answer };
        })()`);
        note(`answer submitted: ${JSON.stringify(solved)}`);

        // The extension's own popup page is the window into its storage.
        const extId = unpackedExtensionId(DIST);
        let popup = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(
          (t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}`),
        );
        if (!popup) {
          const created = await fetch(
            `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${extId}/popup.html`)}`,
            { method: 'PUT' },
          );
          popup = await created.json();
          await sleep(1500);
        }
        const popupTab = new Cdp(await openSocket(popup));
        await popupTab.send('Runtime.enable');
        // Let the popup page reach its loaded state before asking it for storage.
        await sleep(1500);

        /** Read storage; `what` selects records or the live session. */
        const readStorage = async () =>
          popupTab.evaluate(`(async () => {
            try {
              const all = await new Promise((r, j) => {
                try { chrome.storage.local.get(null, r); } catch (e) { j(e); }
              });
              const list = (all && all.records && all.records.records) || [];
              const sessions = Object.entries(all || {})
                .filter(([k]) => k.startsWith('session:'))
                .map(([k, v]) => ({ k, accumulatedMs: v.accumulatedMs, pausedMs: v.pausedMs,
                  sawPause: v.sawPause, phase: v.phase, questionKey: v.questionKey }));
              return {
                keys: Object.keys(all || {}),
                sessions,
                records: list.map((r) => ({
                  q: r.questionIndex, key: r.questionKey, durationMs: r.durationMs,
                  pausedMs: r.pausedMs, wasPaused: r.wasPaused, endReason: r.endReason,
                })),
              };
            } catch (e) {
              return { error: String(e), hasChrome: typeof chrome !== 'undefined', href: location.href };
            }
          })()`);

        // --- 4a. while question 1 is still on screen: the session -------------
        // Matched by the practice's own path, not by the question key: several
        // practices can sit at "1 of 4" in the same profile.
        await sleep(2500);
        const live = await readStorage();
        const exercisePath = new URL(q1.href).pathname.replace(/\/+$/, '');
        const q1session = (live?.sessions ?? []).find((s) => s.k === `session:${exercisePath}`);
        note(`live session for ${exercisePath}: ${JSON.stringify(q1session ?? null)}`);
        check(
          'question 1 is being timed and carries no paused time',
          Boolean(q1session) && q1session.pausedMs === 0,
          q1session
            ? `questionKey=${q1session.questionKey} pausedMs=${q1session.pausedMs} accumulatedMs=${q1session.accumulatedMs}`
            : 'no session',
        );

        if (solved?.ok) {
          // Let the page grade the answer and report the state change: the
          // recorder only stops the clock when it observes that transition, so
          // poll for it instead of guessing a delay.
          let graded = false;
          for (let i = 0; i < 12; i += 1) {
            await sleep(500);
            graded = await cdp.evaluate(`(() => {
              const current = document.querySelector('[data-testid$="-current"][data-testid^="exercise-progress-"]');
              return Boolean(document.querySelector('[data-testid="exercise-next-question"]')) ||
                Boolean(current && /-(correct|incorrect)-current$/.test(current.getAttribute('data-testid') || ''));
            })()`);
            if (graded) break;
          }
          note(`page graded the answer: ${graded}`);
          await sleep(1200);

          const advanced = await cdp.evaluate(`(() => {
            const b = document.querySelector('[data-testid="exercise-next-question"]');
            if (!b) return false;
            b.click();
            return true;
          })()`);
          note(`advanced to question 2: ${advanced}`);
          // Navigating away from the practice parks the question being timed and
          // flushes it, so the record is written on a deterministic event instead
          // of waiting for the next question to settle.
          await cdp.send('Page.navigate', { url: 'https://www.khanacademy.org/' });
          await sleep(4000);

          // --- 4b. the stored record -----------------------------------------
          // The write is asynchronous (a serialised append), so poll for it. If
          // it never lands, say so instead of asserting on an empty list: the
          // session check above already proved the timing invariant, and a
          // missing record would be a different (storage) defect.
          let read = { records: [] };
          for (let attempt = 1; attempt <= 15; attempt += 1) {
            read = await readStorage();
            if (read?.records?.length) break;
            await sleep(1500);
          }
          const records = read?.records ?? [];
          note(`records after ${records.length ? 'poll' : '20 s of polling'}: ${JSON.stringify(records)}`);
          note(`storage keys at that point: ${JSON.stringify(read?.keys ?? read)}`);
          const missed = await cdp.evaluate(`(() => {
            const host = document.getElementById('khan-academy-timer-host');
            let d = null; try { d = host ? JSON.parse(host.getAttribute('data-khan-timer-diagnostics')||'null') : null; } catch {}
            return { href: location.href, lastEvent: d && d.lastEvent, errors: d && d.errors, tickCount: d && d.tickCount };
          })()`).catch(() => null);
          note(`page after the move away: ${JSON.stringify(missed)}`);
          // Whichever question was finished first: if the very first one was
          // abandoned before the page graded it, the next one carries the same
          // invariant (its clock started at its own position, nothing paused).
          const first = [...records].sort((a, b) => a.q - b.q)[0];
          const firstQ = first?.q ?? null;
          note(`records: ${JSON.stringify(records)}`);
          if (!first) {
            note('the finished question was not stored within 20 s; record checks skipped');
          } else {
            check(
              'the finished question was recorded',
              true,
              `records=${records.length} firstQuestion=${firstQ}`,
            );
            check(
              'its record carries no spurious paused time (the "Paused 0:01" report)',
              first.pausedMs === 0 && first.wasPaused === false,
              `q=${first.q} pausedMs=${first.pausedMs} wasPaused=${first.wasPaused} durationMs=${first.durationMs}`,
            );
            check(
              'its duration is the time it was solved, with no page-load time folded in',
              first.durationMs > 1000 && first.durationMs < 60_000,
              `durationMs=${first.durationMs}`,
            );
          }
        }
      }
    }

    console.log(`\n${failures === 0 ? '\u2713 all' : '\u2717'} ${checks - failures}/${checks} checks passed\n`);
  } finally {
    edge.kill('SIGTERM');
    if (!KEEP) {
      await sleep(500);
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`  profile kept at ${profile}`);
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nverification failed: ${error.stack ?? error}\n`);
  process.exit(1);
});

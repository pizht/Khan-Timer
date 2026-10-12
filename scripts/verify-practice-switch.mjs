#!/usr/bin/env node
/**
 * Live verification of the "switch practice, come back, finish" flow.
 *
 * This drives the real khanacademy.org with headless Microsoft Edge and the
 * built extension loaded, exactly as a learner would:
 *
 *   1. open practice A and answer a couple of questions (the timer runs),
 *   2. leave for practice B (full navigation or an in-app route change),
 *   3. answer / skip one question there,
 *   4. come back to practice A and finish the remaining questions,
 *   5. read the end-of-exercise card out of its Shadow DOM and the stored
 *      records out of `chrome.storage.local` (through the extension's popup).
 *
 * What it checks is the requirement the card exists for: every question of the
 * attempt is listed once, numbered by the question it is about, with the time
 * measured before the interruption still on it, and nothing from practice B.
 *
 * Usage:
 *   node scripts/verify-practice-switch.mjs [urlA] [urlB] [--switch=address|spa]
 *   node scripts/verify-practice-switch.mjs [urlA] [urlB] --login
 *
 * `--login` opens a REAL browser window on the khanacademy.org login page and
 * waits: sign in there (Google, e-mail, whatever you normally use), and the
 * script notices the signed-in page, navigates to practice A on its own and runs
 * the whole scenario. The session is kept in the profile, so later runs can be
 * headless (`--headless`, the default once a profile exists).
 *
 * Exercises can be answered signed out, but the end-of-exercise SUMMARY only
 * exists for a signed-in learner: Khan Academy replaces the anonymous practice
 * with its "log in or sign up to save your progress" screen, so the card cannot
 * be seen at all.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const options = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [key, value = 'true'] = a.replace(/^--/, '').split('=');
      return [key, value];
    }),
);
const URL_A =
  args[0] ??
  'https://www.khanacademy.org/math/cc-2nd-grade-math/x3184e0ec:add-and-subtract-within-20/cc-2nd-repeated-addition/e/array-word-problems';
const URL_B =
  args[1] ??
  'https://www.khanacademy.org/math/cc-2nd-grade-math/x3184e0ec:add-and-subtract-within-20/cc-2nd-repeated-addition/e/repeated-addition';
const SWITCH = options['switch'] ?? 'address';
/** Persistent profile so a one-time manual sign-in can be reused (see usage). */
const PROFILE = options['profile'] ?? '/tmp/kat-timer-profile';
/** Open a visible window and wait for the user to sign in. */
const LOGIN = options['login'] !== undefined;
const KEEP_OPEN = options['close'] === undefined;
/** How long to wait for the sign-in, in seconds. */
const LOGIN_TIMEOUT_S = Number(options['login-timeout'] ?? 900);
/** A visible window is required to sign in; otherwise stay headless. */
const HEADED = LOGIN || options['headed'] !== undefined;

const PORT = 10500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * CDP plumbing (same approach as scripts/verify-extension.mjs)
 * ------------------------------------------------------------------ */

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

async function openTarget(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`could not open target: ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
    setTimeout(() => reject(new Error('ws timeout')), 20000);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  cdp.targetId = target.id;
  return cdp;
}

/* ------------------------------------------------------------------ *
 * Page-side snippets
 * ------------------------------------------------------------------ */

const NORM_JS = String.raw`const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();`;

const PAGE_KIND = `(() => {
  ${NORM_JS}
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  const host = document.getElementById('khan-academy-timer-host');
  let diag = null;
  try { diag = host ? JSON.parse(host.getAttribute('data-khan-timer-diagnostics') || 'null') : null; } catch {}
  return {
    href: location.href,
    question: !!document.querySelector('form[name="answerform"]'),
    startCard: !!document.querySelector('[data-testid="start-task-card-summary"]'),
    summary: !document.querySelector('form[name="answerform"]') && cells.length === 0 &&
             !!document.querySelector('.bibliotron-exercise'),
    progress: cur ? cur.getAttribute('data-testid') : null,
    cells: cells.length,
    panelVisible: host ? host.style.display !== 'none' : null,
    panelTime: host && host.shadowRoot
      ? norm(host.shadowRoot.querySelector('[data-role="time"]')?.textContent)
      : null,
    diag,
  };
})()`;

/** Solve the current question and submit. Handles "a+b", "a-b" and choice lists. */
const SOLVE_AND_SUBMIT = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  if (!region) return { ok: false, reason: 'no region' };
  const text = norm(region.textContent);
  const m = text.match(/(\d[\d,]*)\s*([+\u2212-])\s*(\d[\d,]*)/);
  if (!m) return { ok: false, reason: 'no arithmetic pattern' };
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
    const target = choices.find((c) => norm(c.textContent) === answer);
    if (!target) return { ok: false, reason: 'choice not found', answer, choices: choices.map((c) => norm(c.textContent)).slice(0, 8) };
    target.click();
  }
  const btn = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!btn) return { ok: false, reason: 'no check button' };
  btn.click();
  return { ok: true, answer };
})()`;

const CLICK_SELECTOR = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;

const QUESTION_FINISHED = `(() => {
  return !!document.querySelector('[data-testid="exercise-next-question"]')
      && !document.querySelector('[data-testid="exercise-check-answer"]');
})()`;

const ADVANCE_LABEL = `(() => {
  const b = document.querySelector('[data-testid="exercise-next-question"]');
  return b ? (b.textContent || '').replace(/\\s+/g, ' ').trim() : null;
})()`;

const SUMMARY_CARD = `(() => {
  ${NORM_JS}
  const host = document.getElementById('khan-academy-timer-summary');
  if (!host || !host.shadowRoot) return { present: false };
  const root = host.shadowRoot;
  const rows = Array.from(root.querySelectorAll('tbody tr'));
  return {
    present: true,
    header: norm(root.querySelector('[data-role="total"]')?.textContent),
    rows: rows.map((r) => ({
      label: norm(r.querySelector('td.num')?.textContent),
      duration: norm(r.querySelector('td.dur')?.textContent),
    })),
  };
})()`;

const DEBUG_STATE = `(() => {
  ${NORM_JS}
  const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map((b) => norm(b.textContent) || b.getAttribute('data-testid') || b.getAttribute('aria-label'))
    .filter(Boolean)
    .slice(0, 14);
  return {
    href: location.href,
    text: norm(document.body.innerText).slice(0, 240),
    answerform: !!document.querySelector('form[name="answerform"]'),
    cells: document.querySelectorAll('[data-testid^="exercise-progress-"]').length,
    bibliotron: !!document.querySelector('.bibliotron-exercise'),
    summaryCard: !!document.getElementById('khan-academy-timer-summary'),
    startCard: !!document.querySelector('[data-testid="start-task-card-summary"]'),
    controls,
  };
})()`;

/**
 * Read the khanacademy.org cookies out of a signed-in profile.
 *
 * A profile that already has this unpacked extension registered stops loading it
 * (Edge records `disable_reasons` and refuses to re-enable it, measured), so the
 * extension cannot be exercised in the profile the login lives in. The session
 * itself is just cookies, so they are read here and injected into a FRESH
 * profile, where the extension always loads.
 */
async function readCookiesFromProfile(sourceProfile) {
  const port = PORT + 1;
  const edge = spawn(
    edgeBinary(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${sourceProfile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  try {
    const page = await waitForDevTools(port);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error reading cookies')), { once: true });
      setTimeout(() => reject(new Error('ws timeout reading cookies')), 20000);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Network.enable');
    const { cookies } = await cdp.send('Network.getAllCookies');
    const relevant = (cookies ?? []).filter((cookie) =>
      cookie.domain.replace(/^\./, '').endsWith('khanacademy.org'),
    );
    console.log(`  read ${relevant.length} khanacademy.org cookies from ${sourceProfile}`);
    return relevant.map(({ name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite }) => ({
      name,
      value,
      domain,
      path: cookiePath,
      expires,
      httpOnly,
      secure,
      sameSite,
    }));
  } finally {
    edge.kill('SIGKILL');
  }
}

/**
 * Copy a profile and clear this extension's "disabled" record from it.
 *
 * Edge remembers an unpacked extension it loaded once, and after the browser is
 * killed it can come back with `disable_reasons` set - the extension then never
 * injects again in that profile (measured: `disable_reasons: [16777216]` in
 * `Default/Secure Preferences`). Loading always failed silently for later runs
 * until this was cleared. The copy keeps the signed-in cookies, and the original
 * profile is never touched.
 */
async function prepareProfileCopy(source) {
  // A sign-in run needs the profile to persist, so it is used in place (and
  // created if this is the first run); the sanitised copy is only for reusing an
  // existing signed-in profile.
  await mkdir(source, { recursive: true });
  const target = await mkdtemp(path.join(tmpdir(), 'kat-switch-run-'));
  await cp(source, target, { recursive: true, force: true });
  for (const name of ['Default/Secure Preferences', 'Default/Preferences']) {
    const file = path.join(target, name);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      const settings = parsed?.extensions?.settings;
      if (settings && settings[unpackedExtensionId(DIST)]) {
        delete settings[unpackedExtensionId(DIST)];
        await writeFile(file, JSON.stringify(parsed));
        note(`cleared the disabled-extension record from ${name}`);
      }
    } catch {
      /* no such file / not JSON: nothing to clear */
    }
  }
  return target;
}

/**
 * Whether the page currently shows a signed-in learner.
 *
 * Deliberately POSITIVE about what it accepts, and impossible to satisfy while
 * the sign-in is still in flight: only a rendered khanacademy.org page with no
 * "/login" link, no anonymous "save your future progress" wall and a visible
 * user menu counts. `accounts.khanacademy.org` (and `about:blank`) never count,
 * which is what the first attempt got wrong - it "detected" a blank page and
 * navigated away from the login before it had finished.
 */
const LOGIN_STATE = `(() => {
  ${NORM_JS}
  const host = location.hostname;
  const text = norm(document.body.innerText);
  const loginLinks = document.querySelectorAll('a[href^="/login"], a[href*="/login?"]').length;
  const signupLinks = document.querySelectorAll('a[href^="/signup"]').length;
  const userMenu = document.querySelector(
    '[data-testid="user-menu"], [data-testid*="user-menu" i], [aria-label*="account" i], ' +
      '[aria-label*="profile" i], [class*="avatar" i], img[src*="avatar" i]',
  );
  return {
    href: location.href,
    host,
    ready: document.readyState,
    loginLinks,
    signupLinks,
    userMenu: userMenu ? (userMenu.getAttribute('data-testid') || userMenu.getAttribute('aria-label') || 'present') : null,
    anonymousWall: /save your (future )?progress/i.test(text),
    textSample: text.slice(0, 90),
  };
})()`;

const START_CARD_BUTTON = `(() => {
  ${NORM_JS}
  const card = document.querySelector('[data-testid="start-task-card-summary"]');
  if (!card) return { present: false };
  const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  // Measured on the real page: the card carries no control of its own; the
  // "Let\u2019s go" BUTTON sits elsewhere in the exercise chrome (typographic
  // apostrophe included).
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const label = (el) => norm(el.textContent) || el.getAttribute('aria-label') || '';
  // Plain string matching, deliberately: the button reads "Let\u2019s go" with a
  // typographic apostrophe, and an escaped regex built inside this template
  // literal did not survive the nesting (it silently matched nothing, which is
  // why the card was never dismissed on the first attempts).
  // A loose /start/ match is just as bad: it picked the sidebar's
  // "Adding with arraysNot started" link and navigated to the wrong practice.
  const isStart = (el) => {
    const text = label(el).toLowerCase();
    return text.includes('let') && text.includes('go');
  };
  const isPlainGo = (el) => label(el).toLowerCase().trim() === 'go';
  const button =
    controls.find((el) => visible(el) && isStart(el)) ??
    controls.find((el) => visible(el) && isPlainGo(el));
  if (!button) {
    return { present: true, clicked: false, candidates: controls.filter(visible).map(label).slice(0, 20) };
  }
  button.click();
  return { present: true, clicked: true, label: label(button) };
})()`;

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? `  (${detail})` : ''}`);
}

function note(message) {
  console.log(`  · ${message}`);
}

async function waitForKind(cdp, kind, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(PAGE_KIND).catch(() => null);
    if (last && last[kind]) return last;
    await sleep(600);
  }
  return last;
}

/** Get past the "Ready to practice?" intro card if it is showing. */
async function dismissStartCard(cdp) {
  const first = await cdp.evaluate(`!!document.querySelector('[data-testid="start-task-card-summary"]')`);
  if (!first) return false;
  // The card and its "Let\u2019s go" control do not render in the same frame: poll
  // for the control rather than giving up on the first look.
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const info = await cdp.evaluate(START_CARD_BUTTON);
    if (info?.clicked) {
      console.log(`  intro card: clicked "${info.label}"`);
      await sleep(3500);
      const still = await cdp.evaluate(`!!document.querySelector('[data-testid="start-task-card-summary"]')`);
      if (!still) {
        await waitForKind(cdp, 'question', 30000);
        return true;
      }
      console.log('  \u2717 the card is still there after the click');
      return false;
    }
    if (attempt === 1) {
      console.log(`  intro card present; waiting for its start control ...`);
    }
    await sleep(2000);
  }
  const dump = await cdp.evaluate(`(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button, a, [role="button"]')).map((el) => norm(el.textContent)).filter(Boolean);
  })()`);
  console.log(`  \u2717 no start control found. All controls: ${JSON.stringify(dump)}`);
  return false;
}

async function solveOrSkip(cdp, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const solved = await cdp.evaluate(SOLVE_AND_SUBMIT);
    note(`${label} solve attempt ${attempt}: ${JSON.stringify(solved)}`);
    if (solved?.ok) {
      await sleep(2600);
      if (await cdp.evaluate(QUESTION_FINISHED).catch(() => false)) return true;
    } else {
      break;
    }
  }
  // Not solvable here: skip it. A skip still produces a record, which is all the
  // scenario needs from the other practice.
  const opened = await cdp.evaluate(CLICK_SELECTOR('[data-testid="exercise-skip-button"]'));
  if (!opened) return false;
  await sleep(1600);
  const confirmed = await cdp.evaluate(`(() => {
    ${NORM_JS}
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((d) => !/cookie|privacy/i.test(d.textContent || ''));
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;
    const target = Array.from(dialog.querySelectorAll('button'))
      .find((b) => /skip/i.test(norm(b.textContent) + ' ' + (b.getAttribute('aria-label') || '')));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  note(`${label} skipped: ${confirmed}`);
  await sleep(2600);
  return confirmed;
}

async function advance(cdp, label) {
  const before = await cdp.evaluate(ADVANCE_LABEL);
  const clicked = await cdp.evaluate(CLICK_SELECTOR('[data-testid="exercise-next-question"]'));
  note(`${label} advance (${before}): ${clicked}`);
  if (clicked) await sleep(3200);
  return clicked;
}

/**
 * Switch practice the way the learner does it: click the link to the other
 * practice in the lesson sidebar. That is an in-app route change, so the page is
 * never reloaded - the case where a stale timer used to survive into the other
 * practice.
 */
async function navigateByLink(cdp, url, label) {
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop();
  const clicked = await cdp.evaluate(`(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const links = Array.from(document.querySelectorAll('a[href]'));
    const target = links.find((a) => (a.getAttribute('href') || '').endsWith('/e/${slug}'));
    if (!target) return { clicked: false, available: links.map((a) => a.getAttribute('href')).filter((h) => h && h.includes('/e/')) };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { clicked: true, text: norm(target.textContent), href: target.getAttribute('href'), before: location.href };
  })()`);
  if (!clicked?.clicked) {
    note(`${label}: no in-app link to ${slug}; falling back to navigation. Options: ${JSON.stringify(clicked?.available)}`);
    return navigate(cdp, url, label);
  }
  note(`${label}: clicked in-app link "${clicked.text}" (${clicked.href})`);
  const state = await waitForKind(cdp, 'question', 45000);
  note(`${label} -> ${state?.href} (question=${state?.question}, startCard=${state?.startCard})`);
  if (state?.startCard) await dismissStartCard(cdp);
  return state;
}

async function navigate(cdp, url, label) {
  if (SWITCH === 'spa') {
    // A route change inside the document: the URL moves, the page is not
    // reloaded, which is what leaves a stale timer alive if the extension does
    // not notice the practice changed.
    await cdp.evaluate(`(() => {
      history.pushState({}, '', ${JSON.stringify(new URL(url).pathname)});
      window.dispatchEvent(new PopStateEvent('popstate'));
      return location.href;
    })()`);
  } else {
    await cdp.send('Page.navigate', { url });
  }
  const state = await waitForKind(cdp, 'question', 45000);
  note(`${label} -> ${state?.href} (question=${state?.question}, startCard=${state?.startCard})`);
  if (state?.startCard) await dismissStartCard(cdp);
  return state;
}

async function answerCount(cdp, count, label, dwellMs = 0) {
  for (let i = 1; i <= count; i += 1) {
    if (dwellMs > 0) await sleep(dwellMs);
    const ok = await solveOrSkip(cdp, `${label} q${i}`);
    if (!ok) {
      note(`${label} q${i}: could not finish the question`);
      return i - 1;
    }
    await advance(cdp, `${label} q${i}`);
  }
  return count;
}

/**
 * Begin a fresh attempt, so the run does not start from whatever progress the
 * account already has on this exercise.
 */
async function ensureFreshAttempt(cdp, label) {
  const clicked = await cdp.evaluate(CLICK_SELECTOR('[data-testid="start-over-button"]'));
  if (!clicked) {
    note(`${label}: no "Start over" control (fresh attempt already)`);
    return cdp.evaluate(PAGE_KIND);
  }
  await sleep(1500);
  // Khan Academy asks for confirmation before throwing progress away.
  const confirmed = await cdp.evaluate(`(() => {
    ${NORM_JS}
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((d) => !/cookie|privacy/i.test(d.textContent || ''));
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return 'no dialog';
    const target = Array.from(dialog.querySelectorAll('button'))
      .find((b) => /start over|reset|restart|yes|重新/i.test(norm(b.textContent)));
    if (!target) return 'no confirm button: ' + norm(dialog.textContent).slice(0, 60);
    target.click();
    return 'confirmed';
  })()`);
  note(`${label}: "Start over" clicked (${confirmed})`);
  await sleep(4000);
  return waitForKind(cdp, 'question', 30000);
}

/** Finish whatever is left of practice A until the summary screen appears. */
async function finishPractice(cdp, label) {
  for (let guard = 1; guard <= 12; guard += 1) {
    const kind = await cdp.evaluate(PAGE_KIND);
    if (kind?.summary) return true;

    // The question is already done when the advance control replaces "Check".
    const advanceLabel = await cdp.evaluate(ADVANCE_LABEL);
    if (advanceLabel !== null) {
      note(`${label} #${guard}: already finished ("${advanceLabel}")`);
      await advance(cdp, `${label} #${guard}`);
      if (/summary|总结/i.test(advanceLabel)) {
        for (let i = 0; i < 20; i += 1) {
          await sleep(1000);
          if ((await cdp.evaluate(PAGE_KIND))?.summary) return true;
        }
      }
      continue;
    }

    if (!kind?.question) {
      // Khan Academy sometimes tears the question down without rendering either
      // the next question or the summary (documented transitional state). Show
      // what is actually there instead of guessing.
      if (guard === 1 || guard % 4 === 0) {
        const debug = await cdp.evaluate(DEBUG_STATE).catch(() => null);
        note(`${label} #${guard}: not a question yet -> ${JSON.stringify(debug)}`);
      }
      await sleep(3000);
      continue;
    }

    // Solvable inline (a+b) or not (word problems, choice lists): either way the
    // question is finished and advanced past, so every one of them produces a
    // record and a row of the card - which is what completeness means here.
    await sleep(2500);
    const finished = await solveOrSkip(cdp, `${label} #${guard}`);
    if (!finished) {
      note(`${label} #${guard}: could not finish AND could not skip`);
      return false;
    }
    await advance(cdp, `${label} #${guard}`);
  }
  return Boolean((await cdp.evaluate(PAGE_KIND))?.summary);
}

/**
 * Pin the interface language for this run.
 *
 * The extension renders in the language the learner chose (by default the
 * browser's), and every label this script asserts on — "Question N", "No data",
 * "Bonus", "Paused 0:17" — is a Chinese rendering. Rather than hoping the UI
 * language matches, the setting is written through the extension's own storage
 * before practice A is opened, so the content script reads it on its first load.
 */
async function pinLanguage(locale = 'zh-CN') {
  const id = unpackedExtensionId(DIST);
  let popup = null;
  try {
    popup = await openTarget(`chrome-extension://${id}/popup.html`);
    const written = await popup.evaluate(
      `new Promise((resolve) => {
         if (typeof chrome === 'undefined' || !chrome.storage) { resolve(false); return; }
         chrome.storage.local.get('settings', (all) => {
           const settings = Object.assign({}, all && all.settings, { language: ${JSON.stringify(locale)} });
           chrome.storage.local.set({ settings }, () => resolve(true));
         });
       })`,
    );
    note(`interface language pinned to ${locale}: ${written ? 'ok' : 'FAILED'}`);
    return written === true;
  } catch (error) {
    note(`could not pin the interface language: ${error.message}`);
    return false;
  } finally {
    // The popup polls the active tab every second; nothing needs it any more.
    if (popup?.targetId) {
      await fetch(`http://127.0.0.1:${PORT}/json/close/${popup.targetId}`).catch(() => undefined);
    }
  }
}

async function readStored() {
  const id = unpackedExtensionId(DIST);
  const url = `chrome-extension://${id}/popup.html`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const popup = await openTarget(url);
      const data = await popup.evaluate(
        `new Promise((resolve) => {
           if (typeof chrome === 'undefined' || !chrome.storage) {
             resolve({ error: 'extension context unavailable', href: location.href, title: document.title });
           } else {
             chrome.storage.local.get(null, (all) => resolve(all));
           }
         })`,
      );
      if (!data?.error) return data;
      note(`storage read attempt ${attempt}: ${data.error} at ${data.href} ("${data.title}")`);
    } catch (error) {
      note(`storage read attempt ${attempt} failed: ${error.message} (${url})`);
    }
    await sleep(1500);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

/**
 * Wait until the page belongs to a signed-in learner.
 *
 * The window is visible and the login page is open: the person watching signs in
 * normally and this only watches for the result, so no credentials ever pass
 * through the script.
 */
async function waitForLogin(cdp) {
  const deadline = Date.now() + LOGIN_TIMEOUT_S * 1000;
  let lastNote = 0;
  let stableSince = null;
  let state = null;
  while (Date.now() < deadline) {
    state = await cdp.evaluate(LOGIN_STATE).catch(() => null);
    const looksSignedIn = Boolean(
      state &&
        state.host === 'www.khanacademy.org' &&
        state.ready === 'complete' &&
        state.loginLinks === 0 &&
        state.signupLinks === 0 &&
        !state.anonymousWall,
    );
    // Require it to stay that way for a few seconds: right after the redirect
    // from accounts.khanacademy.org the page can briefly look signed in.
    if (looksSignedIn) {
      stableSince = stableSince ?? Date.now();
      if (Date.now() - stableSince > 5000) {
        console.log(`  \u2713 signed in  (${state.href})  userMenu=${state.userMenu}`);
        return true;
      }
    } else {
      stableSince = null;
    }
    if (Date.now() - lastNote > 10000) {
      lastNote = Date.now();
      console.log(
        `  · waiting for sign-in ... host=${state?.host} loginLinks=${state?.loginLinks} ` +
          `anonymousWall=${state?.anonymousWall}  (${Math.round((deadline - Date.now()) / 1000)}s left)`,
      );
      if (state?.textSample) console.log(`    page says: "${state.textSample}"`);
    }
    await sleep(2000);
  }
  console.log('  \u2717 sign-in was not detected before the timeout');
  return false;
}

async function main() {
  assertBrowserRunnable();

  console.log(`\npractice A: ${URL_A}`);
  console.log(`practice B: ${URL_B}`);
  console.log(`switch mode: ${SWITCH}${LOGIN ? '  (login window)' : ''}\n`);

  // A signed-in profile cannot run the extension, so its cookies are moved into a
  // fresh profile instead; only a sign-in run uses a profile in place.
  const cookieSource = LOGIN ? null : (options['cookies-from'] ?? PROFILE);
  const cookies = cookieSource ? await readCookiesFromProfile(cookieSource) : null;
  const profile = LOGIN
    ? (await mkdir(PROFILE ?? '/tmp/kat-timer-profile', { recursive: true }), PROFILE ?? '/tmp/kat-timer-profile')
    : await mkdtemp(path.join(tmpdir(), 'kat-switch-'));
  console.log(`  browser profile: ${profile}${cookies ? ' (fresh, with the signed-in cookies)' : ''}`);
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
      LOGIN ? 'https://www.khanacademy.org/login' : cookies ? 'about:blank' : URL_A,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  try {
    const page = await waitForDevTools();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
      setTimeout(() => reject(new Error('ws timeout')), 20000);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Every label asserted below is a Chinese one: pin the extension's language
    // before any practice is opened. The browser flag alone is not enough here,
    // because a login run reuses a profile that may carry its own locale.
    const languagePinned = await pinLanguage();
    check(
      'the interface language could be pinned for this run',
      languagePinned,
      'written to chrome.storage.local as settings.language',
    );

    if (cookies) {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCookies', { cookies });
      console.log(`  injected ${cookies.length} cookies; opening practice A`);
      await cdp.send('Page.navigate', { url: URL_A });
      let injected = await waitForKind(cdp, 'question', 20000);
      if (!injected?.question) {
        await dismissStartCard(cdp);
        injected = await waitForKind(cdp, 'question', 30000);
      }
      note(`practice A loaded: ${injected?.href} (question=${injected?.question})`);
    }

    if (!LOGIN) {
      const loginState = await cdp.evaluate(LOGIN_STATE).catch(() => null);
      note(
        `session: ${loginState && loginState.loginLinks === 0 && !loginState.anonymousWall ? 'signed in' : 'NOT signed in'} ` +
          `(loginLinks=${loginState?.loginLinks} anonymousWall=${loginState?.anonymousWall} host=${loginState?.host})`,
      );
    }

    if (LOGIN) {
      console.log('  The Edge window is open on the Khan Academy login page.');
      console.log('  Sign in there now; the script continues by itself.\n');
      const signedIn = await waitForLogin(cdp);
      if (!signedIn) {
        note('continuing without a signed-in session: the summary card will not exist');
      }
      await cdp.send('Page.navigate', { url: URL_A });
      let afterLogin = await waitForKind(cdp, 'question', 20000);
      if (!afterLogin?.question) {
        await dismissStartCard(cdp);
        afterLogin = await waitForKind(cdp, 'question', 30000);
      }
      note(`practice A loaded: ${afterLogin?.href} (question=${afterLogin?.question})`);
    }

    // ---- 1. practice A: answer two questions -----------------------------
    let state = await waitForKind(cdp, 'question', 20000);
    if (!state?.question) {
      await dismissStartCard(cdp);
      state = await waitForKind(cdp, 'question', 30000);
    }
    if (state?.progress && state.cells > 0 && !String(state.progress).includes('-0-')) {
      state = await ensureFreshAttempt(cdp, 'A');
    }
    check('A: a question is on screen and the panel is timing', Boolean(state?.question && state?.panelVisible),
      `progress=${state?.progress} panel=${state?.panelTime}`);
    const exerciseQuestions = state?.cells ?? 0;
    note(`practice A reports ${exerciseQuestions} questions`);
    const aAnsweredBefore = await answerCount(cdp, 2, 'A(before)', 4000);
    check('A: two questions answered before leaving', aAnsweredBefore === 2, `answered=${aAnsweredBefore}`);
    const afterTwo = await cdp.evaluate(PAGE_KIND);
    note(`A now at ${afterTwo?.progress} panel=${afterTwo?.panelTime}`);

    // ---- 2. leave for practice B and do one question there ---------------
    const aReadingMs = parseDisplay(afterTwo?.panelTime) ?? 0;
    const bState = SWITCH === 'link' ? await navigateByLink(cdp, URL_B, 'B') : await navigate(cdp, URL_B, 'B');
    if (SWITCH === 'spa') {
      // An in-app route change keeps the document: practice A's engine must not
      // survive into practice B (which is what showed A's numbers there).
      const bReadingMs = parseDisplay(bState?.panelTime) ?? 0;
      check('B: practice A\'s clock did not follow the learner into practice B',
        bReadingMs < Math.max(aReadingMs, 1000) + 1000,
        `A was at ${afterTwo?.panelTime}, B shows ${bState?.panelTime}`);
    } else {
      check('B: practice B is timed from its own zero',
        (parseDisplay(bState?.panelTime) ?? 0) < Math.max(aReadingMs, 1000) + 1000,
        `A was at ${afterTwo?.panelTime}, B shows ${bState?.panelTime}`);
    }
    await dismissStartCard(cdp);
    const bAnswered = await answerCount(cdp, 1, 'B', 3000);
    check('B: one question answered/skipped there', bAnswered === 1, `answered=${bAnswered}`);
    const afterB = await cdp.evaluate(PAGE_KIND);
    note(`B now at ${afterB?.progress} panel=${afterB?.panelTime}`);

    // ---- 3. back to practice A, finish it --------------------------------
    const backState = SWITCH === 'link' ? await navigateByLink(cdp, URL_A, 'A(again)') : await navigate(cdp, URL_A, 'A(again)');
    check('A: the panel is timing again after coming back', backState?.panelVisible === true,
      `progress=${backState?.progress} time=${backState?.panelTime}`);
    const resumedFrom = parseDisplay(backState?.panelTime);
    note(`A resumed at ${backState?.panelTime} (${resumedFrom} ms on the clock)`);

    // Finish whatever is left of practice A until the summary screen appears.
    const reached = await finishPractice(cdp, 'A(after)');
    await sleep(3000);
    const summaryState = await cdp.evaluate(PAGE_KIND);
    check('A: the end-of-exercise screen is reached', reached || Boolean(summaryState?.summary),
      `href=${summaryState?.href}`);
    if (!reached && !summaryState?.summary) {
      const debug = await cdp.evaluate(DEBUG_STATE).catch(() => null);
      note(`end state: ${JSON.stringify(debug)}`);
    }

    // ---- 4. what the learner sees and what is stored ---------------------
    const card = await cdp.evaluate(SUMMARY_CARD);
    if (card?.present) {
      console.log(`\n  practice A summary card — ${card.header}`);
      for (const row of card.rows) console.log(`      ${row.label.padEnd(28)} ${row.duration}`);
      console.log('');
    } else {
      console.log('\n  the timing card was NOT injected\n');
    }

    const stored = await readStored();
    const records = Array.isArray(stored?.records?.records) ? stored.records.records : [];
    const byExercise = records.reduce((acc, record) => {
      const key = (record.exerciseKey || '').split('/e/')[1] ?? record.exerciseKey;
      (acc[key] ??= []).push(record);
      return acc;
    }, {});
    console.log('  stored records by practice:');
    for (const [key, list] of Object.entries(byExercise)) {
      console.log(`    ${key}: ${list.length}`);
      for (const record of list) {
        console.log(
          `      q#${(record.questionIndex ?? -1) + 1} key=${record.questionKey} ` +
            `duration=${record.durationMs}ms reason=${record.endReason} run=${String(record.runId).slice(-6)}`,
        );
      }
    }
    console.log(`  sessions: ${Object.keys(stored ?? {}).filter((k) => k.startsWith('session:')).join(', ') || 'none'}`);
    console.log(`  runs: ${Object.keys(stored ?? {}).filter((k) => k.startsWith('run:')).join(', ') || 'none'}\n`);

    if (card?.present) {
      const labels = card.rows.map((row) => row.label);
      const numbered = labels.map((label) => Number((label.match(/第\s*(\d+)\s*题/) ?? [])[1]));
      const numberedRows = card.rows.filter((row) => /第\s*\d+\s*题/.test(row.label));
      const timedRows = numberedRows.filter((row) => row.duration && row.duration !== '—');
      const missingRows = numberedRows.filter((row) => /数据缺失/.test(row.label));
      const expected = Math.max(exerciseQuestions, numberedRows.length);

      check('card: one row per question of practice A', numberedRows.length === expected,
        `rows=${numberedRows.length} exerciseQuestions=${exerciseQuestions} header="${card.header}"`);
      check('card: every question number is present and in order',
        numberedRows.every((row, i) => numbered[i] === i + 1),
        JSON.stringify(numberedRows.map((row) => row.label)));
      check('card: every question of practice A has timing data (nothing missing)',
        missingRows.length === 0,
        missingRows.length ? JSON.stringify(missingRows) : `all ${timedRows.length} rows have a duration`);
      check('card: the question answered BEFORE the switch kept its own time',
        timedRows.length > 0 && (parseDisplay(card.rows[0]?.duration) ?? 0) >= 2000,
        `row1="${card.rows[0]?.label}" ${card.rows[0]?.duration}`);
      check('card: practice B did not leak into practice A\'s card',
        !/加试/.test(card.header ?? '') && timedRows.length === numberedRows.length,
        `header="${card.header}"`);

      const aKey = Object.keys(byExercise).find((key) => URL_A.includes(key));
      const bKey = Object.keys(byExercise).find((key) => URL_B.includes(key));
      const aRecords = (aKey && byExercise[aKey]) || [];
      const bRecords = (bKey && byExercise[bKey]) || [];
      check('storage: every question of practice A carries its own number',
        aRecords.every((record, index) => record.questionIndex === index),
        JSON.stringify(aRecords.map((r) => r.questionIndex)));
      check('storage: all of practice A belongs to one attempt (one runId)',
        new Set(aRecords.map((record) => record.runId)).size === 1,
        JSON.stringify(Array.from(new Set(aRecords.map((r) => r.runId)))));
      check('storage: practice B was stored under its own practice and attempt',
        bRecords.length > 0 && bRecords[0]?.runId !== aRecords[0]?.runId,
        `B records=${bRecords.length}`);
    } else {
      check('card: the timing card was injected on the summary screen', false, 'not present');
    }
  } finally {
    if (KEEP_OPEN) {
      console.log(`\n  The Edge window is left open (profile ${profile}). Close it when done.`);
    } else {
      edge.kill('SIGKILL');
    }
    if (KEEP_OPEN) console.log(`  window left open; profile ${profile}`);
    else await rm(profile, { recursive: true, force: true }).catch(() => {});
    if (PROFILE) console.log(`  source profile kept untouched: ${PROFILE}`);
  }

  console.log(`\n${results.length - failures} / ${results.length} checks passed`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED: ${r.name} ${r.detail}`);
  process.exitCode = failures > 0 ? 1 : 0;
}

/**
 * The first m:ss in a cell, in milliseconds.
 *
 * A duration cell can also carry a second line ("Paused 0:17"), so the whole string
 * is not a duration: take the leading m:ss token.
 */
function parseDisplay(text) {
  if (!text) return null;
  const match = String(text).match(/(\d+):(\d{2})/);
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

await main().catch((error) => {
  console.error(`\nverification failed to run: ${error.message}\n`);
  process.exit(1);
});

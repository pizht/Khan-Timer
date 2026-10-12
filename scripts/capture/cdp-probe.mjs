#!/usr/bin/env node
/**
 * Decisive probe #2.
 *
 * Two questions that MUST be answered from real observation:
 *
 *  A. What does a genuine question ADVANCE look like? (Solve the arithmetic in
 *     the stem, submit it, then click the exercise's own "Next question".)
 *     Records progress index, stem text and region-node identity before/after.
 *
 *  B. Where do HINTS / the step-by-step solution live in the DOM? A previous
 *     run proved they render INSIDE `form[name="answerform"]`, which means a
 *     naive text fingerprint would fire a false question change when a learner
 *     opens a hint. We need the exact container to exclude.
 *
 * Dumps full DOM at every stage so the selectors come from real markup.
 *
 * Usage: node cdp-final.mjs <url> <outDir>
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_ARG = process.argv[2];
const OUT_DIR = process.argv[3] ?? '.';
const PORT = 9900 + Math.floor(Math.random() * 90);
const PROFILE = path.join(OUT_DIR, `.cdp-profile-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error('devtools endpoint never became ready');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const p = m.id ? this.pending.get(m.id) : null;
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(`${m.error.code}: ${m.error.message}`)); else p.resolve(m.result);
    });
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout ${method}`)); }, t);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.value;
  }
}

const READ = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  const m = cur ? (cur.getAttribute('data-testid') || '').match(/exercise-progress-(\\d+)-/) : null;
  const region = document.querySelector('form[name="answerform"]');
  const hintish = region ? Array.from(region.querySelectorAll('*')).filter((n) => {
    const t = norm(n.textContent);
    return /^Hint #\\d/.test(t) && t.length < 4000;
  }).map((n) => ({ tag: n.tagName.toLowerCase(), cls: norm(n.className).slice(0,90),
                   testid: n.getAttribute('data-testid'), role: n.getAttribute('role'),
                   text: norm(n.textContent).slice(0,60) })) : [];
  return {
    progressIndex: m ? Number(m[1]) : null,
    currentTestId: cur ? cur.getAttribute('data-testid') : null,
    allTestIds: cells.map((el) => el.getAttribute('data-testid')),
    regionTextLen: region ? norm(region.textContent).length : null,
    regionHtmlLen: region ? region.outerHTML.length : null,
    regionText: region ? norm(region.textContent).slice(0, 200) : null,
    // Fingerprint WITHOUT any hint-ish subtree, as the detector would compute it.
    stemOnlyText: region ? (() => {
      const c = region.cloneNode(true);
      c.querySelectorAll('[role="dialog"],[aria-live]').forEach((n) => n.remove());
      return norm(c.textContent).slice(0, 200);
    })() : null,
    hintishNodes: hintish.slice(0, 10),
    firstPerseusRendererText: (() => {
      const r = document.querySelector('.perseus-renderer');
      return r ? norm(r.textContent).slice(0, 160) : null;
    })(),
    perseusRendererCount: document.querySelectorAll('.perseus-renderer').length,
    checkButton: !!document.querySelector('[data-testid="exercise-check-answer"]'),
    nextButton: !!document.querySelector('[data-testid="exercise-next-question"]'),
    skipButton: !!document.querySelector('[data-testid="exercise-skip-button"]'),
    hintControl: (() => {
      const b = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((el) => /hint/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
      return b ? { text: norm(b.textContent), aria: b.getAttribute('aria-label'),
                   testid: b.getAttribute('data-testid'), cls: norm(b.className).slice(0,80) } : null;
    })(),
  };
})()`;

/** Solve "a+b" style stems so we can submit a correct answer without hardcoding. */
const SOLVE_AND_SUBMIT = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  if (!region) return { ok: false, reason: 'no region' };
  const text = norm(region.textContent);
  const m = text.match(/(\\d[\\d,]*)\\s*[+＋]\\s*(\\d[\\d,]*)/);
  if (!m) return { ok: false, reason: 'no a+b pattern', text: text.slice(0, 120) };
  const answer = String(Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')));
  const input = region.querySelector('input[type="text"], input:not([type]), textarea');
  if (!input) return { ok: false, reason: 'no input' };
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!btn) return { ok: false, reason: 'no check button', answer };
  btn.click();
  return { ok: true, answer, expr: m[0] };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(PROFILE, { recursive: true });
  const edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${PROFILE}/crash`,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
    '--disable-features=Translate,MediaRouter', `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1000', URL_ARG,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const log = []; const note = (s) => { log.push(s); console.log(s); };
  let cdp;
  const stages = [];

  try {
    const page = await waitForDevTools();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
      setTimeout(() => rej(new Error('ws timeout')), 20000);
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

    for (let i = 0; i < 60; i += 1) {
      const ok = await cdp.evaluate(`!!document.querySelector('form[name="answerform"]')`).catch(() => false);
      if (ok) break;
      await sleep(1000);
    }
    await sleep(3000);

    const snap = async (label, dumpDom = true) => {
      const sig = await cdp.evaluate(READ);
      stages.push({ label, sig });
      await writeFile(path.join(OUT_DIR, `final-${label}.json`), JSON.stringify(sig, null, 2), 'utf8');
      if (dumpDom) {
        const html = await cdp.evaluate(`document.documentElement.outerHTML`);
        await writeFile(path.join(OUT_DIR, `final-${label}.html`), html, 'utf8');
      }
      note(`--- ${label}\n${JSON.stringify(sig, null, 2)}`);
      return sig;
    };

    await snap('0-initial');

    // --- A. Real advance: solve, submit, then click the exercise's own next button.
    for (let round = 1; round <= 3; round += 1) {
      const submitted = await cdp.evaluate(SOLVE_AND_SUBMIT);
      note(`round ${round}: submit -> ${JSON.stringify(submitted)}`);
      await sleep(3000);
      await snap(`${round}a-submitted`);

      const next = await cdp.evaluate(`(() => {
        const b = document.querySelector('[data-testid="exercise-next-question"]');
        if (!b) return 'no-next-button';
        b.click(); return 'clicked';
      })()`);
      note(`round ${round}: next-question -> ${next}`);
      if (next !== 'clicked') {
        note(`round ${round}: cannot advance (no next button); stopping advance loop`);
        break;
      }
      await sleep(4000);
      const after = await snap(`${round}b-after-advance`);
      note(`round ${round}: index ${stages[stages.length - 2].sig.progressIndex} -> ${after.progressIndex}`);
    }

    // --- B. Hints / solution markup.
    const hintClick = await cdp.evaluate(`(() => {
      const c = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((el) => /^hints?$/i.test((el.textContent || '').trim()) ||
                      /^hints?$/i.test((el.getAttribute('aria-label') || '').trim()));
      if (!c) return { clicked: false };
      c.click();
      return { clicked: true, text: (c.textContent || '').trim(), cls: (c.className || '').slice(0, 80),
               testid: c.getAttribute('data-testid') };
    })()`);
    note(`hint control -> ${JSON.stringify(hintClick)}`);
    await sleep(3000);
    await snap('hints-open');

    // Also try the "Show a step" / solution expander if present.
    const stepClick = await cdp.evaluate(`(() => {
      const c = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((el) => /show a step|step-by-step/i.test((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')));
      if (!c) return { clicked: false };
      c.click();
      return { clicked: true, text: (c.textContent || '').trim() };
    })()`);
    note(`step control -> ${JSON.stringify(stepClick)}`);
    await sleep(3000);
    await snap('solution-open');

    await writeFile(path.join(OUT_DIR, 'final-log.txt'), log.join('\n') + '\n', 'utf8');
    await writeFile(path.join(OUT_DIR, 'final-stages.json'), JSON.stringify(stages, null, 2), 'utf8');
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    edge.kill('SIGKILL');
    await sleep(500);
    await rm(PROFILE, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });

#!/usr/bin/env node
/**
 * Focused diagnostic for a detector that appears to be "stuck".
 *
 * Loads the built extension into real Edge, drives a real Khan Academy
 * exercise, and prints both the raw page view (progress testids, question
 * region text, button lifecycle) and the extension's own view (read from the
 * `data-khan-timer-diagnostics` attribute the content script mirrors onto the
 * panel host). Run this when the panel stops reacting; comparing the two views
 * separates "the page did not change" from "the detector did not notice".
 *
 * Usage:
 *   node cdp-extension-diagnostics.mjs <exerciseUrl> [outDir]
 *
 * Writes a log to <outDir>/cdp-diagnostics.log (default: a temp directory).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root is two levels up from scripts/capture/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const EDGE = process.env.EDGE_BIN
  ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_ARG = process.argv[2];
// Where the log is written. Defaults to the current directory so the log
// survives; the throwaway browser profile is deleted on exit.
const OUT_DIR = process.argv[3] ?? process.cwd();

if (!URL_ARG) {
  console.error('usage: node cdp-extension-diagnostics.mjs <exerciseUrl> [outDir]');
  process.exit(2);
}
const PORT = 10600 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (res.ok) {
        const p = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (p) return p;
      }
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error('no devtools');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const p = m.id ? this.pending.get(m.id) : null;
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    });
  }
  send(method, params = {}, t = 30000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, t);
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

const RAW = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const footers = Array.from(document.querySelectorAll('[data-testid="content-library-footer"]'));
  const regions = Array.from(document.querySelectorAll('form[name="answerform"]'));
  const vis = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: Math.round(r.width), h: Math.round(r.height),
             display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
  };
  return {
    cellTestIds: cells.map((c) => ({ id: c.getAttribute('data-testid'), aria: c.getAttribute('aria-label'),
                                     parentVis: vis(c.parentElement) })),
    currentCount: cells.filter((c) => (c.getAttribute('data-testid') || '').endsWith('-current')).length,
    footerCount: footers.length,
    footerVisibility: footers.map(vis),
    regionCount: regions.length,
    regionTexts: regions.map((r) => norm(r.textContent).slice(0, 80)),
    check: !!document.querySelector('[data-testid="exercise-check-answer"]'),
    next: !!document.querySelector('[data-testid="exercise-next-question"]'),
    nextDisabled: (() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      return b ? { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'),
                   pointerEvents: getComputedStyle(b).pointerEvents,
                   rect: (() => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })() } : null;
    })(),
    checkDisabled: (() => {
      const b = document.querySelector('[data-testid="exercise-check-answer"]');
      return b ? b.disabled : null;
    })(),
  };
})()`;

const DIAG = `(() => {
  const host = document.getElementById('khan-academy-timer-host');
  if (!host) return { present: false };
  const raw = host.getAttribute('data-khan-timer-diagnostics');
  return raw ? JSON.parse(raw) : { present: true, diag: null };
})()`;

const PANEL = `(() => {
  const host = document.getElementById('khan-academy-timer-host');
  if (!host || !host.shadowRoot) return null;
  const q = (r) => host.shadowRoot.querySelector('[data-role="' + r + '"]');
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  return { time: norm(q('time')?.textContent), meta: norm(q('meta')?.textContent), footer: norm(q('foot')?.textContent) };
})()`;

const SOLVE = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  const m = norm(region && region.textContent).match(/(\\d[\\d,]*)\\s*[+]\\s*(\\d[\\d,]*)/);
  if (!m) return { ok: false };
  const answer = String(Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')));
  const input = region.querySelector('input[type="text"], input:not([type])');
  const proto = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const b = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!b) return { ok: false, why: 'no check' };
  b.click();
  return { ok: true, answer };
})()`;

async function main() {
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  await mkdir(OUT_DIR, { recursive: true }).catch(() => undefined);
  const profile = await mkdtemp(path.join(tmpdir(), 'kat-dbg-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crash`,
    '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
    '--disable-features=Translate,MediaRouter', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
    '--window-size=1440,1000', URL_ARG,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let cdp;
  try {
    const page = await waitForDevTools();
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
      setTimeout(() => rej(new Error('ws timeout')), 20000);
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

    for (let i = 0; i < 60; i += 1) {
      if (await cdp.evaluate(`!!document.querySelector('form[name="answerform"]')`).catch(() => false)) break;
      await sleep(1000);
    }
    await sleep(4000);

    const dump = async (label) => {
      const raw = await cdp.evaluate(RAW);
      const panel = await cdp.evaluate(PANEL);
      const diag = await cdp.evaluate(DIAG).catch(() => null);
      log(`\n===== ${label} =====`);
      log('  raw: ' + JSON.stringify(raw));
      log('  panel: ' + JSON.stringify(panel));
      log('  DIAG: ' + JSON.stringify(diag));
      return { raw, panel };
    };

    await dump('BEFORE submit');
    log('  solve: ' + JSON.stringify(await cdp.evaluate(SOLVE)));
    await sleep(3500);
    await dump('AFTER submit (correct)');

    const clicked = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      if (!b) return 'missing';
      b.click();
      return 'clicked';
    })()`);
    log(`\n  next click -> ${clicked}`);
    await sleep(1500);
    await dump('1.5s after next');
    await sleep(4000);
    await dump('5.5s after next');

    // Try clicking again, in case the first click only moved focus.
    const again = await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      if (!b) return 'missing';
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      b.click();
      return 'clicked-again';
    })()`);
    log(`\n  next click again -> ${again}`);
    await sleep(4000);
    await dump('after second next click');
    const logPath = path.join(OUT_DIR, 'cdp-diagnostics.log');
    await writeFile(logPath, lines.join('\n') + '\n', 'utf8').catch(() => undefined);
    console.log(`\n  full log: ${logPath}`);
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    edge.kill('SIGKILL');
    await sleep(600);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });

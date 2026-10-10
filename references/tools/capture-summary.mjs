#!/usr/bin/env node
/**
 * Drive a whole exercise to completion with the extension loaded and screenshot
 * the end-of-exercise summary card.
 *
 * Screenshots are evidence for the research folder, not part of the build.
 *
 * Usage: node capture-summary.mjs <exerciseUrl> <outDir>
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const EDGE = process.env.EDGE_BIN
  ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const URL_ARG = process.argv[2];
const OUT_DIR = process.argv[3] ?? path.join(ROOT, 'references', 'screenshots');
const PORT = 11600 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!URL_ARG) {
  console.error('usage: node capture-summary.mjs <exerciseUrl> <outDir>');
  process.exit(2);
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'failed');
    return r.result?.value;
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

const SOLVE = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const region = document.querySelector('form[name="answerform"]');
  if (!region) return { ok: false, reason: 'no region' };
  const m = norm(region.textContent).match(/(\d[\d,]*)\s*[+]\s*(\d[\d,]*)/);
  if (!m) return { ok: false, reason: 'no a+b' };
  const answer = String(Number(m[1].replace(/,/g, '')) + Number(m[2].replace(/,/g, '')));
  const input = region.querySelector('input[type="text"], input:not([type]), textarea');
  if (!input) return { ok: false, reason: 'no input' };
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, answer);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('[data-testid="exercise-check-answer"]');
  if (!btn) return { ok: false, reason: 'no check' };
  btn.click();
  return { ok: true, answer };
})()`;

const STATE = String.raw`(() => {
  const cells = Array.from(document.querySelectorAll('[data-testid^="exercise-progress-"]'));
  const cur = cells.find((el) => (el.getAttribute('data-testid') || '').endsWith('-current'));
  const m = cur && (cur.getAttribute('data-testid') || '').match(/exercise-progress-(\d+)-(.+?)(?:-current)?$/);
  return {
    index: m ? Number(m[1]) : null,
    state: m ? m[2] : null,
    summary: !document.querySelector('form[name="answerform"]') && cells.length === 0
      && !!document.querySelector('.bibliotron-exercise'),
    advanceLabel: (() => {
      const b = document.querySelector('[data-testid="exercise-next-question"]');
      return b ? (b.textContent || '').replace(/\s+/g, ' ').trim() : null;
    })(),
  };
})()`;

const CARD = String.raw`(() => {
  const host = document.getElementById('khan-academy-timer-summary');
  if (!host || !host.shadowRoot) return null;
  const rows = Array.from(host.shadowRoot.querySelectorAll('tbody tr'));
  return { rows: rows.map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim()) };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'kat-shot-sum-'));

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
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
      setTimeout(() => reject(new Error('ws timeout')), 20000);
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false,
    });

    for (let i = 0; i < 60; i += 1) {
      if (await cdp.evaluate(`!!document.querySelector('form[name="answerform"]')`).catch(() => false)) break;
      await sleep(1000);
    }
    // Dismiss the donation / onboarding interstitials.
    await cdp.evaluate(`(() => {
      const hits = [document.querySelector('[data-testid="close-donate-banner"]'),
                    document.querySelector('[data-testid="close-button"]')].filter(Boolean);
      for (const h of hits) { try { h.click(); } catch {} }
      for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        if (d.closest('#khan-academy-timer-host')) continue;
        if (/cookie|privacy/i.test(d.textContent || '')) continue;
        d.style.display = 'none';
      }
      return true;
    })()`).catch(() => undefined);
    await sleep(3000);

    for (let round = 1; round <= 10; round += 1) {
      const before = await cdp.evaluate(STATE);
      if (before?.summary) break;
      console.log(`round ${round}: index=${before?.index} state=${before?.state} label=${before?.advanceLabel}`);

      let graded = false;
      for (let attempt = 1; attempt <= 3 && !graded; attempt += 1) {
        const solved = await cdp.evaluate(SOLVE);
        if (!solved?.ok) break;
        await sleep(2600);
        const st = await cdp.evaluate(STATE);
        graded = st?.state === 'correct';
        console.log(`   attempt ${attempt}: ${solved.answer} -> ${st?.state}`);
      }

      const moved = await cdp.evaluate(`(() => {
        const b = document.querySelector('[data-testid="exercise-next-question"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!moved) {
        console.log('   no advance control; stopping');
        break;
      }
      await sleep(4200);
    }

    await sleep(2500);
    // Khan Academy raises an onboarding modal once the exercise is finished; it
    // covers the summary content, so clear it before the screenshot.
    const cleared = await cdp.evaluate(String.raw`(() => {
      let removed = 0;
      for (const d of Array.from(document.querySelectorAll('[role="dialog"]'))) {
        if (d.closest('#khan-academy-timer-host')) continue;
        if (/cookie|privacy/i.test(d.textContent || '')) continue;
        d.style.display = 'none';
        removed += 1;
      }
      for (const s of Array.from(document.querySelectorAll('[data-testid="close-button"]'))) {
        try { s.click(); } catch {}
      }
      return removed;
    })()`);
    console.log(`  hidden modals: ${cleared}`);
    await sleep(800);
    const card = await cdp.evaluate(CARD);
    console.log(`summary card rows: ${JSON.stringify(card?.rows)}`);

    const shot = path.join(OUT_DIR, 'summary-per-question-times.png');
    await cdp.screenshot(shot);
    console.log(`wrote ${shot}`);
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

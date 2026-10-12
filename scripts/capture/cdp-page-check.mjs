#!/usr/bin/env node
/**
 * Does the current site profile recognise a given page type?
 *
 * Also reports whether the page is sitting behind a "Let's go" intro card,
 * which quiz / unit-test / course-challenge pages show before the questions.
 * Used to check new page types before claiming support for them.
 *
 * Loads each URL in real Edge, clicks any "start" control an assessment puts in
 * front of the questions, and reports which of the project's selector
 * strategies match. Used to check new page types (e.g. SAT test-prep) before
 * claiming support for them.
 *
 * Usage:
 *   node cdp-page-check.mjs <outDir> <url> [url...]
 *
 * Writes one <pageN>.json / <pageN>.html per URL plus a combined
 * page-check-report.json, and prints a per-page summary to stdout.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EDGE = process.env.EDGE_BIN
  ?? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const OUT_DIR = process.argv[2] ?? process.cwd();
const URLS = process.argv.slice(3);
const PORT = 12100 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (URLS.length === 0) {
  console.error('usage: node cdp-page-check.mjs <outDir> <url> [url...]');
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
}

/** Exactly the strategies src/site-profile.ts uses, plus a structural survey. */
const PROBE = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const qa = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
  const q = (s) => qa(s)[0] || null;
  const cells = qa('[data-testid^="exercise-progress-"]');
  const answers = qa('input, textarea, select, [contenteditable="true"]').map((el) => ({
    tag: el.tagName.toLowerCase(),
    testid: el.getAttribute('data-testid'),
    type: el.getAttribute('type'),
    aria: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
  }));
  return {
    url: location.href,
    title: document.title,

    // Every strategy the profile currently tries.
    profile: {
      questionRegion: {
        answerform: !!q('form[name="answerform"]'),
        frameworkPerseus: !!q('.framework-perseus'),
        perseusRenderer: !!q('.perseus-renderer'),
      },
      progress: {
        progressCells: cells.length,
        current: cells.map((c) => c.getAttribute('data-testid')).filter((t) => (t || '').endsWith('-current')),
      },
      controls: {
        checkAnswer: !!q('[data-testid="exercise-check-answer"]'),
        nextQuestion: !!q('[data-testid="exercise-next-question"]'),
        skip: !!q('[data-testid="exercise-skip-button"]'),
        startOver: !!q('[data-testid="start-over-button"]'),
        footer: !!q('[data-testid="content-library-footer"]'),
        contentPanelWrapper: !!q('[data-testid="content-panel-wrapper"]'),
      },
      summary: {
        isSummaryPage: !q('form[name="answerform"]') && cells.length === 0 && !!q('.bibliotron-exercise'),
      },
      exerciseId: (q('[data-exercise-id]') || {}).getAttribute
        ? q('[data-exercise-id]').getAttribute('data-exercise-id')
        : null,
    },

    // Is an assessment sitting behind an intro screen?
    intro: {
      startish: qa('button, [role="button"]')
        .map((b) => norm(b.textContent) || norm(b.getAttribute('aria-label')))
        .filter((t) => /^start|begin|continue|resume|take|practice/i.test(t || ''))
        .slice(0, 12),
    },

    answers,
    bibliotronExercise: !!q('[class*="bibliotron-exercise"]'),
    allTestIds: Array.from(new Set(qa('[data-testid]').map((el) => el.getAttribute('data-testid')))).sort(),
    testIdsWithWord: Array.from(new Set(qa('[data-testid]')
      .map((el) => el.getAttribute('data-testid'))
      .filter((t) => /question|exercise|answer|choice|progress|perseus|widget|radio|check|skip|content/i.test(t || '')))).sort(),
    bodyTextHead: norm(document.body.textContent).slice(0, 320),
  };
})()`;

const CLICK_START = String.raw`(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  // The quiz / unit-test / course-challenge intro card uses "Let's go"
  // (typographic apostrophe). "Start over" is the exercise reset control and
  // must NOT be treated as a start button.
  const patterns = [/^let.s go/, /^let us go/, /^start(?! over)/, /^begin/, /^continue/, /^resume/];
  for (const b of buttons) {
    if (b.disabled) continue;
    const label = norm(b.textContent) || norm(b.getAttribute('aria-label'));
    if (patterns.some((re) => re.test(label))) {
      b.click();
      return { clicked: true, label };
    }
  }
  const card = document.querySelector('[data-testid="start-task-card-summary"]');
  return {
    clicked: false,
    startCard: card ? norm(card.textContent).slice(0, 160) : null,
    available: buttons.map((b) => norm(b.textContent)).filter(Boolean).slice(0, 15),
  };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const profile = await mkdtemp(path.join(tmpdir(), 'kat-check-'));
  const report = [];

  for (const [index, url] of URLS.entries()) {
    const edge = spawn(EDGE, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-crash-reporter', '--disable-breakpad', `--crash-dumps-dir=${profile}/crash`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun',
      '--disable-features=Translate,MediaRouter', `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`, '--window-size=1440,1000', url,
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
      await sleep(7000);

      const before = await cdp.evaluate(PROBE);
      let after = null;
      const started = await cdp.evaluate(CLICK_START);
      if (started?.clicked) {
        await sleep(7000);
        after = await cdp.evaluate(PROBE);
      }

      const stem = `page${index + 1}`;
      await writeFile(path.join(OUT_DIR, `${stem}.json`),
        JSON.stringify({ url, before, startClicked: started, after }, null, 2), 'utf8');
      const html = await cdp.evaluate('document.documentElement.outerHTML');
      await writeFile(path.join(OUT_DIR, `${stem}.html`), html, 'utf8');

      report.push({ url, startClicked: started, before, after });
      console.log(`\n===== page${index + 1}: ${url}`);
      console.log(`  start control: ${JSON.stringify(started)}`);
      console.log(`  BEFORE profile: ${JSON.stringify(before?.profile)}`);
      console.log(`  BEFORE intro:   ${JSON.stringify(before?.intro)}`);
      if (after) {
        console.log(`  AFTER  profile: ${JSON.stringify(after?.profile)}`);
        console.log(`  AFTER  answers: ${JSON.stringify(after?.answers)}`);
        console.log(`  AFTER  testids(q/a/progress): ${JSON.stringify(after?.testIdsWithWord)}`);
      }
    } catch (error) {
      console.log(`\n===== page${index + 1} FAILED: ${error.message}`);
      report.push({ url, error: error.message });
    } finally {
      try {
        cdp?.ws.close();
      } catch {
        /* ignore */
      }
      edge.kill('SIGKILL');
      await sleep(800);
    }
  }

  await writeFile(path.join(OUT_DIR, 'page-check-report.json'), JSON.stringify(report, null, 2), 'utf8');
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\nreport written to ${path.join(OUT_DIR, 'page-check-report.json')}`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});

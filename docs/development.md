# Khan Academy Timer — Developer Guide

A **per-question timer** for Khan Academy exercises and quizzes: it detects the question being
solved and times it, with count-up / countdown, pause / resume / reset, an in-page floating panel
and a "time per question" card on the end-of-exercise screen. Manifest V3 + TypeScript + esbuild,
loadable in **Chrome and Edge** (Chromium 114+); all data stays on the local machine.

> **This file is for maintainers.** Installation and usage are covered by the
> **[user guide](../README.md)** (English) and its **[Simplified Chinese version](../README.zh-CN.md)**.

**Two hard constraints** — do not break either one; `scripts/verify-dist.mjs` asserts both
mechanically:

1. **No network code in the build.** If any of `fetch`, `XMLHttpRequest`, `WebSocket`,
   `EventSource`, `sendBeacon`, `eval`, `new Function`, `importScripts`, remote script injection or
   an absolute http(s) URL appears in `dist/*.js`, the build check fails.
2. **Only `storage` + `activeTab` as permissions**, with the content script matching
   `khanacademy.org` only: no `host_permissions`, no background worker, no
   `web_accessible_resources`.

---

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
- [Architecture and invariants](#architecture-and-invariants)
- [Code layout](#code-layout)
- [Verification and CI](#verification-and-ci)
- [Releasing](#releasing)
- [Permissions](#permissions)
- [Documentation map](#documentation-map)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Node.js ≥ 20. The pnpm version is pinned by `packageManager` in `package.json`
(`corepack enable` makes that take effect automatically).

```bash
pnpm install
pnpm run build      # produce dist/
pnpm run verify     # full offline check: typecheck + unit tests + build + dist checks
```

To debug in a browser: `chrome://extensions` or `edge://extensions` → turn on **Developer mode** →
**Load unpacked** → select **`dist/`**. **Browsers only ever load `dist/`; `src/` is the source.**

After changing source there are three steps: `pnpm run build` → click the **reload** (↻) icon on the
extension card → refresh the Khan Academy tab. Browsers do not notice changes in `dist/` on their own.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm run build` | Bundles with esbuild into `dist/` (**deliberately unminified**, with source maps, so a human can review the "no data is uploaded" claim) |
| `pnpm run build:watch` | Rebuilds on source changes |
| `pnpm run typecheck` | `tsc --noEmit` (strict) |
| `pnpm run test` / `test:watch` | vitest (jsdom; `chrome.storage` is replaced by an in-memory double) |
| `pnpm run verify` | typecheck + test + build + `verify-dist.mjs`, **fully offline** — usable as a commit gate |
| `pnpm run icons` | Regenerates `public/icons/*.png` from `assets/logo.png` (Node's built-in `zlib` only, no image dependency) |
| `pnpm run verify:edge` | Real Edge end to end: loads `dist/`, drives the live exercise page, reads the panel's Shadow DOM |
| `pnpm run verify:startcard` | Real Edge: no panel flash on the practice start card + no spurious paused time on question 1 |
| `pnpm run verify:practice-switch` | Real Edge: practice A → B → back to A to finish the attempt (the summary card needs a signed-in session; see the script header) |

The three real-browser scripts resolve the browser in the order `EDGE_PATH` → platform default
install location → `PATH`; the logic lives in
[`scripts/lib/browser.mjs`](../scripts/lib/browser.mjs). For a non-default location:

```bash
EDGE_PATH="/path/to/msedge" pnpm run verify:edge
```

When no browser is found, the script fails **before** starting any process and lists every path it
tried.

---

## Architecture and invariants

The behaviours below were established empirically on the live site and are locked down by unit
tests. **Read the matching test before changing detection, timing or storage** — it is easy to
reintroduce a bug that was already fixed. The "why" for each one lives in the source comments; before
changing a selector, capture a fresh copy of the real DOM as described in
[`AGENTS.md`](../AGENTS.md).

| Invariant | Explanation | Main location |
|---|---|---|
| **Question identity = progress index** | Identity is the **index** in `exercise-progress-<index>-<state>`, never the state segment — the state changes on every answer submission, so including it would mean "answering a question counts as a question change". The site exposes no stable per-question id. | `question-detector.ts`, `site-profile.ts` |
| **An identity upgrade is not a question change** | On load the question region appears first (text fingerprint only) and the progress marker ~20–190 ms later. That is an **identity upgrade of the same question** and must preserve the engine and the session, otherwise every question would restart from zero a second after loading. | `question-detector.ts` |
| **Timing starts when the page reports the question number** | While the region is rendered but no position is known: no panel, no timing, no accumulated paused time. This removed the phantom `Paused 0:01` on question 1. | `controller.ts` |
| **The panel only appears over a question being solved** | The host `#khan-academy-timer-host` mounts as `display:none` and is only shown by the render loop once a position is reported; it stays hidden on start cards, lesson pages and videos, and never flashes. | `overlay.ts`, `controller.ts` |
| **Detection failure = pause, not reset** | When the question region or any identity signal is missing: hide the panel and **pause** the question (engine, accumulated time, first-submission timestamp and `runId` are all kept), then resume from the paused value when the same question returns; **a pause the learner asked for is never auto-resumed**. The unreadable stretch is not counted as time, but the question still appears in the end-of-exercise summary. | `controller.ts`, `timer-engine.ts` |
| **When the clock stops** | A correct answer (state `correct`, or the Check button being replaced by the next-question control — the progress marker keeps only the **first** submission's verdict, so a wrong-then-correct retry does not change it) and a confirmed Skip stop the clock; a wrong answer, a cancelled Skip, selecting an option or typing an answer do not. | `controller.ts` |
| **Time semantics** | Elapsed time is always derived from timestamp differences, never from timer ticks (background tabs and post-sleep wake-ups stay correct). The clock **freezes** while the page is closed or the learner is away from the practice; `session:<practice path>` is stored per practice with a 12-hour TTL and only resumes when both the practice and the question match. | `timer-engine.ts`, `storage.ts` |
| **A practice switch in the SPA invalidates the old identity immediately** | Any address change invalidates detection state: the first question of a new practice must be a new question even if the progress index is identical, otherwise the old practice's readout keeps climbing. | `controller.ts` |
| **The summary card reads through three layers** | `exerciseKey` (which set of questions) → `attempt:<practice path>` (the current attempt window, only advanced once the summary screen was really seen) → `runId`. Rows are ordered by **question number**; a question number with no data keeps its row and is tagged `No data` rather than pulling the next question's time up into it; bonus questions sort after the numbered ones. | `summary-view.ts`, `storage.ts` |
| **Record writes are serialised** | `chrome.storage` has no transactions, so concurrent "read → append → write back" cycles overwrite each other (a missing row on the summary card). All writes go through one queue and readers `flush()` it first. | `storage.ts` |
| **i18n: `en.ts` is the source of truth for keys** | `MessageKey` is derived from `src/i18n/en.ts`; every other language is a `Record<MessageKey, string>`, so **a missing translation fails to compile**; `_locales/` only holds the extension name and description. | `src/i18n/`, [`docs/i18n.md`](i18n.md) |
| **One source for the version number** | `scripts/build.mjs` writes `package.json`'s `version` into `dist/manifest.json`; the manifest only accepts plain dotted-numeric versions. | `scripts/build.mjs` |

Debounce and cooldown defaults (overridable in settings, not exposed in the popup): a new identity
must stay stable for **400 ms** and be **≥ 1200 ms** after the last accepted change; once a candidate
appears, the detector schedules one deferred re-check.

The design rationale for detection details (which container is the question region, why opening a
hint does not reset the timer, why `Start over` counts as a new question, …) lives in the source
comments: every selector in `src/site-profile.ts` is tagged with how it was established
(`[OBS]` observed on the live site / `[VER]` verified by driving a real browser / `[STD]` platform
standard hook).

---

## Code layout

```text
src/
├── content.ts             # content-script entry (no side effects; starts the controller)
├── controller.ts          # timing controller: detection events → timing / records / sessions / summary
├── question-detector.ts   # question detection: pure decision logic + DOM adapter
├── site-profile.ts        # ★ every site selector and adaptation rule lives here
├── timer-engine.ts        # count-up/countdown state machine (pure logic, injectable clock)
├── storage.ts             # settings, records, in-flight sessions, write queue
├── overlay.ts             # in-page floating panel (Shadow DOM)
├── summary-view.ts        # "time per question in this attempt" card (Shadow DOM)
├── popup.ts               # extension popup logic
├── i18n/                  # all UI copy: en.ts source of truth + zh-CN.ts translation + t()/localizeDom()
├── sound.ts               # countdown tone (synthesised with Web Audio, no audio files)
├── types.ts / util.ts     # shared types / fingerprint hashing and helpers
public/                    # manifest.json, popup.html/css, _locales/, icons/ (copied wholesale at build time)
scripts/                   # build + icon generation + the verification scripts
scripts/capture/           # live-site DOM capture / sanitisation (for AI agents and maintainers, see AGENTS.md)
tests/                     # vitest (8 files)
docs/                      # this developer guide and the i18n notes (the user guide is README.md / README.zh-CN.md)
assets/logo.png            # icon source art; pnpm run icons generates public/icons/ from it
```

Captured DOM data (raw captures, sanitised excerpts, screenshots) is **deliberately not versioned**
and always lands in the gitignored `.tmp-caps/`: it goes stale the moment Khan Academy ships a
change, and a stale sample that still looks authoritative is worse than no sample. Re-capture when
needed with the two commands in [`AGENTS.md`](../AGENTS.md) (that path is reproducible — two
captures taken days apart were byte-identical). The design conclusions drawn from those captures are
not archived separately; they are written straight into the source comments, so reading
`src/site-profile.ts` (where each selector carries a provenance tag) shows the "why". For the same
reason, **there is no maintained list of unverified page types**: when the extension meets a page it
cannot read, it says so and pauses the clock — the behaviour is the statement.

`site-profile.ts` holds every site selector and adaptation rule: when the site changes, edit that one
file and do not scatter selectors into other modules. `dist/` is pure build output and is gitignored.

---

## Verification and CI

Three of the four verification layers can be re-run at any time: the first two are fully offline, the
real-browser layer needs a local Edge and network access, and the remaining manual steps are listed
with the `verify:*` commands.

| Layer | Command | Current size | Coverage |
|---|---|---|---|
| Unit tests | `pnpm run test` | **271 cases / 8 files** | timer engine, detection decisions and DOM adapter, controller (jsdom end to end, including practice switching and the summary row model), storage and the write queue, summary row ordering, panel/popup, i18n |
| Build check | `node scripts/verify-dist.mjs` | **61 checks** | manifest parses and every file it references exists, permission allowlist, content-script match scope, no network/dynamic-execution code in `dist/*.js`, icon sizes, `_locales` and every `__MSG_*` resolves |
| Real browser | `pnpm run verify:edge`, `verify:startcard`, `verify:practice-switch` | end to end | loads `dist/` as an unpacked extension into real Edge and reads the panel's Shadow DOM and `chrome.storage.local` over CDP |

Scenarios that are hard to reproduce reliably in a real browser (for example "detection fails →
pause → resume") have been rewritten as jsdom end-to-end cases where possible — see
*pauses instead of resetting when the question region disappears and comes back* in
`tests/controller.test.ts`. For the rest, follow the prompts printed by the three `verify:*` commands.

Workflows:

| Workflow | Trigger | What it runs |
|---|---|---|
| [`verify.yml`](../.github/workflows/verify.yml) | push / PR (+ manual) | `pnpm run verify`, fully offline, as the commit gate |
| [`e2e.yml`](../.github/workflows/e2e.yml) | manual only | installs Edge on the runner and runs `pnpm run verify:edge` (needs network and drives the live site, so it must not gate ordinary commits) |
| [`release.yml`](../.github/workflows/release.yml) | pushing a `v*` tag | see the next section |

`verify:practice-switch` is not part of any workflow: its summary-card assertions need a real
signed-in account.

---

## Releasing

1. Bump `version` in `package.json` and commit it to `main`;
2. `git tag v0.3.0 && git push origin v0.3.0` (the tag's version must equal `package.json`'s, and it
   must point at a commit on `main`, or `release.yml` fails outright and publishes nothing).

The workflow runs `pnpm run verify`, then packs `dist/` into a ZIP whose **archive root is the
extension itself** (`manifest.json` at the top level), so the same ZIP both works for users loading
it unpacked and can be uploaded to a store as-is. Entries are sorted, carry no extra attributes and
have their timestamps pinned to the tagged commit, so **rebuilding the same commit yields a
byte-identical ZIP**; the release also ships `SHA256SUMS.txt` so anyone can recompute it. A tag with a
suffix (`v0.3.0-rc.1`) is published as a pre-release.

---

## Permissions

| Permission | Purpose | Code |
|---|---|---|
| `storage` | Save settings, timing records and in-flight sessions locally | `src/storage.ts` |
| `activeTab` | Let the popup read the live timer status of the current tab | `src/popup.ts` |

The content script matches only `https://www.khanacademy.org/*` and
`https://*.khanacademy.org/*`. There is **no** `host_permissions`, `tabs`, `cookies`,
`clipboardRead`, `geolocation`, microphone or camera access — and no "might be useful later"
permissions. `verify-dist.mjs` treats this as a hard check.

---

## Documentation map

| Document | Reader | Content |
|---|---|---|
| [`README.md`](../README.md) | **users** | The user guide on the repo home page (English, the default entry point): downloading the ZIP from a release and importing it into Chrome / Edge, usage, settings, privacy, troubleshooting |
| [`README.zh-CN.md`](../README.zh-CN.md) | **users** | The same user guide in Simplified Chinese; the two README files link to each other |
| [`docs/i18n.md`](i18n.md) | maintainers | The i18n design, language resolution, and **the steps to add another language** |
| [`AGENTS.md`](../AGENTS.md) | AI agents / maintainers | Must-read before changing a selector: how to capture the real DOM yourself instead of inferring it |
| this file (`docs/development.md`) | maintainers | Architecture and invariants, verification and CI, project layout, permissions, releasing, troubleshooting |

---

## Troubleshooting

**`pnpm run test` fails to load Rollup's native module** (`Cannot find module
@rollup/rollup-<platform>`, `ERR_DLOPEN_FAILED ... different Team IDs`): `pnpm-workspace.yaml`
already overrides `rollup` with the pure WebAssembly build (`@rollup/wasm-node`), so this should not
happen; if the native version got installed anyway, run
`rm -rf node_modules pnpm-lock.yaml && pnpm install`.

**Nothing changes in the browser after a build**: browsers do not notice `dist/` changing. Click
**reload** (↻) on the extension card, then refresh the page.

**A real-browser script cannot find the browser**: check `EDGE_PATH`, or use one of the candidate
paths the script lists when it fails; `verify:edge` needs network access and drives the live Khan
Academy site.

**The version changed in `package.json` but not in the manifest**: `build.mjs` syncs the manifest at
build time — just run `pnpm run build` again, and never hand-edit `version` in
`public/manifest.json`.

**The panel readout or the records look wrong**: first open the popup's **developer mode** and read
the diagnostics (matched selector strategy, confidence, question key, last event). On the page you can
also read them directly:

```js
JSON.parse(document.getElementById('khan-academy-timer-host')
  .getAttribute('data-khan-timer-diagnostics'))
```

where `unidentified: true` means the page genuinely cannot be read at that moment.

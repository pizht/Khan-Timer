# Khan Academy Timer

A **Chrome / Edge** extension that times Khan Academy questions. Installed manually from a ZIP
file.

All data is stored locally.

**English** · [简体中文](README.zh-CN.md)

---

**Jump to:** [Install](#install) · [Update](#updating-to-a-new-version) · [Uninstall](#uninstalling) ·
[Using it](#using-it) · [Settings](#settings) · [Privacy](#your-data-and-privacy) ·
[Problems](#troubleshooting) · [FAQ](#faq)

## Features

- **Times each question automatically.** Open a practice exercise and a small floating panel appears
  in the corner of the page and starts counting. When you move to the next question, the reading
  restarts and the time you spent on the previous question is saved.
- **Count up or count down.** The countdown runs down from the limit you set, with a clear
  "over time" state and an optional beep.
- **A summary at the end.** The summary screen lists the time you spent on each question of the
  attempt.
- **Keeps the data on your machine.** Records live in your browser's local storage. The extension
  makes no network requests at all, and it never sends anything anywhere.

It does **not** answer questions, submit answers, skip questions, or change your Khan Academy
progress or scores. It only watches which question is on screen and how long it has been there.

## Requirements

| | |
|---|---|
| Browser | **Google Chrome 114+** or **Microsoft Edge 114+** (other Chromium browsers usually work too, but only Chrome and Edge are tested) |
| Computer | Windows, macOS or Linux desktop. |
| Where it works | Pages on `khanacademy.org` — practice exercises and quizzes |
| Khan Academy account | Not needed for the timer itself |

## Install

The extension is **not** in the Chrome Web Store or the Edge Add-ons store, so you install it
manually from the download on the Releases page.

### 1. Download the ZIP

Open the releases page:

**<https://github.com/pizht/Khan-Timer/releases/latest>**

Under **Assets**, click the file named `khan-timer-<version>.zip`.

> Do **not** download "Source code (zip)" or "Source code (tar.gz)" — those are the raw source files.

### 2. Unzip it into a folder you will keep

> **Keep this folder where it is.** The browser loads the extension from it every time it starts.
> If you move or delete it, the timer stops working.

### 3. Open the extensions page

| Browser | Address |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

Type it into the address bar and press Enter.

### 4. Load the extension

1. Turn on **Developer mode** — top-right corner in Chrome, left sidebar in Edge.
2. Click **Load unpacked**.
3. Select the folder from step 2 (the one containing `manifest.json`) and confirm.

A card named **Khan Academy Timer** appears in the list. If you instead get
*"Manifest file is missing or unreadable"*, you selected the wrong folder — go back to step 2.

### 5. Pin it to the toolbar (recommended)

Click the puzzle-piece icon next to the address bar and pin **Khan Academy Timer**. The icon is
where you open the settings and see the current status.

### 6. Try it

Open any practice exercise, for example:

```text
https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4
```

A **Question timer** panel appears in the top-right corner of the page and starts counting.

> **Two things browsers may tell you afterwards**
>
> - Chrome or Edge can show a notice at start-up about extensions installed in developer mode.
>   Choose the option that **keeps** them (usually *Cancel* or *Keep*). If you pick *Disable*,
>   the timer is switched off until you turn it back on in the extensions page.
> - The extension may be listed as "loaded unpacked" or similar. That is normal for an extension
>   installed this way, and it is why the ZIP has to stay on your disk.

## Updating to a new version

1. Download the new ZIP from the same [releases page](https://github.com/pizht/Khan-Timer/releases/latest).
2. Unzip it and copy the files **over your existing folder**, replacing everything. Keep the folder
   path exactly the same.
3. Open `chrome://extensions` or `edge://extensions` and click the **reload** icon (↻) on the
   Khan Academy Timer card.
4. Refresh the Khan Academy tab.

Your settings and your timing history are kept, because the extension is still loaded from the
same folder.

> If you prefer to unzip into a *new* folder instead, remove the old copy from the extensions page
> first — otherwise you will have two timers running on the same page. Note that a new folder means
> a new extension identity, so your settings and history start from scratch.

## Uninstalling

1. Open `chrome://extensions` or `edge://extensions`.
2. Click **Remove** on the Khan Academy Timer card and confirm.
3. Delete the folder you unzipped.

Removing the extension also deletes its saved settings and timing history from the browser.
If you only want to erase the history and keep using the timer, use **Clear all records** in the
popup instead.

## Using it

### Where the panel appears

| Page | What happens |
|---|---|
| A practice exercise with a question on screen | Panel shows, timing runs |
| A quiz or unit test with a question on screen | Panel shows, timing runs |

### The end-of-exercise card

After you finish the last question of a set and Khan Academy shows its summary screen, a card named
**Time per question in this attempt** appears above the results.

- Click the title (or the small arrow) to collapse and expand it; the choice is remembered.
- Each row shows the question number, a `Correct` / `Incorrect` / `Skipped` / `Over time` tag and
  the time. Questions that were never timed are listed as `No data`.
- If you paused part-way through a question, its row also shows a small `Paused 0:05` note; the
  paused time is not counted in the total.
- The card is added above Khan Academy's own content, so nothing that was already on the page is
  covered.
- Two practical notes: this card appears only on the real summary screen (finish every question
  first, including any bonus question), and Khan Academy usually shows that screen only when you
  are signed in.

## Settings

Click the toolbar icon to open the popup. The top card shows the live status of the current tab;
the middle card holds the settings. Changes apply immediately — in the popup, in the floating
panel, and on already-open pages.

| Setting | Default | What it does |
|---|---|---|
| **Language** | Automatic (browser language) | Interface language: Automatic (browser language), English, or 中文（简体）. On automatic, Chinese browsers get Chinese and everything else falls back to English. |
| **Default timer mode** | Count up (record time spent) | Mode used when a new question starts. |
| **Time limit per question (seconds)** | 60 | The countdown length. Any value from 5 to 3600. |
| **Play a tone when the countdown reaches zero** | On | A short two-tone beep synthesised by the browser — no audio file is downloaded. |
| **Show the floating panel on the page** | On | The master switch. Turn it off and the timer keeps working invisibly. |
| **Start the panel collapsed as a small pill** | Off | The panel starts as a small pill you can click to expand. |
| **Resume the previous time when the page is reopened** | On | Reopening the same question continues the previous total instead of starting over. |
| **Developer mode** | Off | Shows detection details in the popup and the panel. Useful when reporting a problem; not needed for normal use. |

## History

The bottom card of the popup, **History**, lists your most recent records: the question number
(`Q2/4`), the time, whether you were over the limit, and the result of your first submission.

- Up to the **500** most recent records are kept; older ones are dropped automatically.
- **Clear all records** deletes the history but keeps your settings. The button appears only when
  there is something to clear.
- Question text and your answers are never stored. Only the timing data and a short local
  fingerprint of the question are kept.

## Your data and privacy

- **Everything stays on your computer.** Records are stored in the browser's local storage for this
  extension. There is no account, no server and no analytics.
- **The extension cannot send anything anywhere.** It contains no network code at all — no
  `fetch`, no `XMLHttpRequest`, no WebSocket, no remote scripts. This is checked automatically on
  every build (61 checks, including a scan of the built files for any network or dynamic-code
  calls).
- **It asks for two permissions only:**

  | Permission | Why |
  |---|---|
  | `storage` | To save your settings and timing records locally |
  | `activeTab` | So the popup can read the timer status of the tab you are looking at |

  It has no access to your browsing history, your cookies, your passwords, your clipboard or your
  files, and it runs only on `khanacademy.org`.
- **Removing everything:** clear the records in the popup, and/or remove the extension from the
  extensions page — removing it deletes its local data as well.
- The extension is not affiliated with, endorsed by, or connected to Khan Academy.

## Troubleshooting

| Symptom | What to do |
|---|---|
| *"Manifest file is missing or unreadable"* when loading | You selected the wrong folder. Pick the folder that contains `manifest.json` directly (see [step 2](#2-unzip-it-into-a-folder-you-will-keep)). |
| No panel on a practice page | Make sure a question is actually on screen (the "Ready to practice?" card is not a question), then refresh the page. Check that the extension is still enabled in `chrome://extensions` / `edge://extensions`. |
| The panel disappeared and the popup says *"No question identified"* | This is expected: at that moment the page does not say which question is on screen. The timer **pauses** instead of counting that time, and resumes by itself when the same question is identified again. The question is not lost — it still appears in the end-of-exercise card. If it never comes back, that page type is not supported yet. |
| A question starts with time already on the clock | You are on a question you had open before, or you left the practice and came back — that is the *"Resume the previous time"* setting. Press **Reset question** to start from `0:00`, or turn the setting off. |
| No beep when the countdown reaches zero | Browsers block sound until you interact with the page. Click anywhere on the page, then try again. |
| The timer vanished after restarting the browser | A browser notice about developer-mode extensions may have disabled it. Open the extensions page, turn Khan Academy Timer back on, and choose *Keep*/*Cancel* the next time that notice appears. |
| Settings and history are empty after an update | The extension was loaded from a different folder, so it is a different installation. Unzip updates over the *same* folder next time. |
| The panel shows `Detection: weak signal` or question changes are missed | That page does not expose the progress marker the timer normally uses. Use **Reset question** when you move on manually, and report the page if you like. |
| The summary card does not appear at the end | It appears only after the last question of the attempt (including any bonus question), and Khan Academy usually shows that screen only to signed-in users. |
| Two panels or two timers at once | You have two copies installed. Remove one of them on the extensions page. |

## FAQ

**Does it answer or submit anything for me?**
No. It only observes which question is on screen. It never clicks Check, never picks an answer and
never skips a question.

**Does it change my Khan Academy progress or scores?**
No.

**Is my data uploaded anywhere?**
No. The extension makes no network requests. You can verify this yourself: the built files are
shipped unminified, and the build fails if any network call appears in them.

**Does it work while I am signed in?**
Yes. Signing in is only relevant to Khan Academy's own summary screen (see above).

**Do I need an account, or internet, while using it?**
No account is needed, and the timer works offline once installed.

**Does it work on quizzes, unit tests and course challenges?**
It tries to detect questions on any Khan Academy exercise or quiz page. Practice exercises are the
most thoroughly verified; unsupported pages will say so in the popup instead of pretending to work.

**Does it work in Chrome and Edge at the same time?**
Yes — install the same ZIP in each browser separately. Each browser keeps its own settings and
history.

**Does it work in Firefox, Safari, or on a phone or tablet?**
No. It is built for Chromium-based desktop browsers (Chrome, Edge, and similar).

**Which version do I have?**
The popup header shows `v<version>`, for example `v0.3.0`.

## Reporting a problem

Open an issue at **<https://github.com/pizht/Khan-Timer/issues>** and include:

1. your browser and its version,
2. the extension version shown in the popup header,
3. the exercise URL where it happened,
4. what the popup's status card says — turn on **Developer mode** in the settings first, since that
   adds the detection details (strategy, confidence, question key, last event).

> Building from source or maintaining the extension? See the **[developer guide](docs/development.md)**
> and **[AGENTS.md](AGENTS.md)** — architecture and invariants, the offline verification gate, and how
> to derive site selectors from real DOM.

# Khan Academy Timer — User Guide

**English** · [简体中文](#简体中文)

---

## English

A small Chrome / Edge extension that times every question you answer on Khan Academy.
It is installed by hand from a ZIP file — **there is nothing to build** — and it keeps all of its
data on your own computer.

**Jump to:** [Install](#install-2-minutes) · [Update](#updating-to-a-new-version) · [Uninstall](#uninstalling) ·
[Using it](#using-it) · [Settings](#settings) · [Privacy](#your-data-and-privacy) ·
[Problems](#troubleshooting) · [FAQ](#faq)

### What it does

- **Times each question automatically.** Open a practice exercise and a small floating panel appears
  in the corner of the page and starts counting. When you move to the next question, the panel
  restarts at `0:00` and the time you spent on the previous question is saved.
- **Count up or count down.** Count up to see how long a question takes; count down to keep to a
  time limit you set, with a visible "over time" state and an optional beep.
- **Shows a summary at the end.** When you finish the last question, the summary screen gets a card
  listing the time you spent on each question of that attempt.
- **Keeps the data on your machine.** Records live in your browser's local storage. The extension
  makes no network requests at all, and it never sends anything anywhere.

It does **not** answer questions, submit answers, skip questions, or change your Khan Academy
progress or scores. It only watches which question is on screen and how long it has been there.

### Requirements

| | |
|---|---|
| Browser | **Google Chrome 114+** or **Microsoft Edge 114+** (both are Chromium-based — the same ZIP works in both). Other Chromium browsers usually work the same way, but only Chrome and Edge are tested. |
| Computer | Windows, macOS or Linux desktop. Extensions cannot be installed on phones or tablets. |
| Where it works | Pages on `khanacademy.org` — practice exercises and quizzes |
| Khan Academy account | Not needed for the timer itself |

### Install (2 minutes)

The extension is **not** in the Chrome Web Store or the Edge Add-ons store, so you install it
manually from the download on the Releases page. It takes about two minutes and you only do it once.

#### 1. Download the ZIP

Open the releases page:

**<https://github.com/pizht/Khan-Timer/releases/latest>**

Under **Assets**, click the file named `khan-timer-<version>.zip`
(for example `khan-timer-0.3.0.zip`).

> Do **not** download "Source code (zip)" or "Source code (tar.gz)" — those are the raw source
> files and will not install.

#### 2. Unzip it into a folder you will keep

Unzip the download (double-click it on Windows/macOS) into a permanent place, for example
`Documents\khan-timer` or `~/Documents/khan-timer`.

Open the folder and check that you can see `manifest.json` **directly inside it**, next to
`content.js`, `popup.html`, `icons` and `_locales`:

```text
khan-timer/
├── manifest.json     ← this file must be directly in the folder
├── content.js
├── popup.html
├── popup.js
├── popup.css
├── icons/
└── _locales/
```

If you only see a single folder inside, open it — that inner folder is the one you need.
If you see `manifest.json` inside a `dist` folder, use the `dist` folder.

> **Keep this folder where it is.** The browser loads the extension from it every time it starts.
> If you move or delete it, the timer stops working.

#### 3. Open the extensions page

| Browser | Address |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

Type it into the address bar and press Enter.

#### 4. Load the extension

1. Turn on **Developer mode** — top-right corner in Chrome, left sidebar in Edge.
2. Click **Load unpacked**.
3. Select the folder from step 2 (the one containing `manifest.json`) and confirm.

A card named **Khan Academy Timer** appears in the list. If you instead get
*"Manifest file is missing or unreadable"*, you selected the wrong folder — go back to step 2.

#### 5. Pin it to the toolbar (recommended)

Click the puzzle-piece icon next to the address bar and pin **Khan Academy Timer**. The icon is
where you open the settings and see the current status.

#### 6. Try it

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

### Updating to a new version

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

### Uninstalling

1. Open `chrome://extensions` or `edge://extensions`.
2. Click **Remove** on the Khan Academy Timer card and confirm.
3. Delete the folder you unzipped — it is no longer needed.

Removing the extension also deletes its saved settings and timing history from the browser.
If you only want to erase the history and keep using the timer, use **Clear all records** in the
popup instead.

### Using it

#### Where the panel appears

| Page | What happens |
|---|---|
| A practice exercise with a question on screen | Panel shows, timing runs |
| A quiz or unit test with a question on screen | Panel shows, timing runs |
| The "Ready to practice?" start card before question 1 | Nothing — there is no question yet, so there is nothing to time |
| Lesson pages, videos, articles, the course outline | Nothing — those pages have no questions |
| The end-of-exercise summary screen | No panel; the per-question card is added instead |

The panel follows the question, not the page: it appears as soon as the page confirms which
question you are on, so it will never show a clock that cannot measure anything.

#### The panel

| Part | What it does |
|---|---|
| Time readout | The time for the current question, `m:ss` |
| Mode tag | `Count up` or `Countdown` |
| `Limit 60s` / `Over +0:12` | In countdown mode: your limit, and how far past it you are |
| `Progress 1 of 4` | Which question of the set you are on |
| **Pause** / **Resume** | Stops or restarts the clock for this question |
| **Reset question** | Sets *this* question back to `0:00`. Other questions and saved records are untouched. |
| `–` button | Collapses the panel to a small pill showing only the time; click the pill to expand again |
| Header drag | Drag the title bar to move the panel anywhere; the position is remembered |
| `Done` / `Paused` badge | Shown after you answer correctly, skip, or pause |

In countdown mode, when the time runs out the panel turns red and shows the overrun
(for example `Over +0:12`). Nothing is submitted or skipped automatically — it is only a signal
to you.

#### When the clock stops for a question

| You do this | The timer |
|---|---|
| Answer correctly and press **Check** | Stops, and the panel shows `Done` |
| Answer incorrectly | Keeps running — you can retry |
| Press **Skip**, then confirm **Yes, skip** | Stops |
| Press **Skip**, then **Cancel** | Keeps running |
| Type an answer, open a hint, or select an option | Keeps running |
| Move to the next question | Saves the finished question and starts the new one at `0:00` |

#### The end-of-exercise card

After you finish the last question of a set and Khan Academy shows its summary screen, a card named
**Time per question in this attempt** appears above the results:

```text
Time per question in this attempt                     3 questions · 0:12 total
──────────────────────────────────────────────────────────────────────────────
Question                                                       Time
Question 1   Correct                                           0:04
Question 2   Skipped                                           0:05
Question 3   Correct                                           0:03
```

- Click the title (or the small arrow) to collapse and expand it; the choice is remembered.
- Each row shows the question number, a `Correct` / `Incorrect` / `Skipped` / `Over time` tag and
  the time. Questions that were never timed are listed as `No data` rather than silently shifting
  the other rows.
- If you paused part-way through a question, its row also shows a small `Paused 0:05` note; the
  paused time is not counted in the total.
- The card is added above Khan Academy's own content, so nothing that was already on the page is
  covered.
- Two practical notes: this card appears only on the real summary screen (finish every question
  first, including any bonus question), and Khan Academy usually shows that screen only when you
  are signed in.

### Settings

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

### History

The bottom card of the popup, **History**, lists your most recent records: the question number
(`Q2/4`), the time, whether you were over the limit, and the result of your first submission.

- Up to the **500** most recent records are kept; older ones are dropped automatically.
- **Clear all records** deletes the history but keeps your settings. The button appears only when
  there is something to clear.
- Question text and your answers are never stored. Only the timing data and a short local
  fingerprint of the question are kept.

### Your data and privacy

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

### Troubleshooting

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

### FAQ

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

### Reporting a problem

Open an issue at **<https://github.com/pizht/Khan-Timer/issues>** and include:

1. your browser and its version,
2. the extension version shown in the popup header,
3. the exercise URL where it happened,
4. what the popup's status card says — turn on **Developer mode** in the settings first, since that
   adds the detection details (strategy, confidence, question key, last event).

---

## 简体中文

一个用于 **Chrome / Edge** 的小扩展，为可汗学院（Khan Academy）的每道题计时。
它通过 ZIP 手动安装 —— **不需要任何构建** —— 所有数据都只保存在你自己的电脑上。

**快速跳转：** [安装](#安装2-分钟) · [升级](#升级到新版本) · [卸载](#卸载) · [使用](#使用) ·
[设置](#设置) · [隐私](#你的数据与隐私) · [疑难解答](#疑难解答) · [常见问题](#常见问题)

### 它做什么

- **自动为每道题计时。** 打开一个练习页，页面角落会出现一个小悬浮面板并开始计时；
  切到下一题时读数从 `0:00` 重新开始，上一题的用时会被保存下来。
- **正计时或倒计时。** 正计时用来看一道题花了多久；倒计时按你设置的限时倒数，归零后
  有明显的「超时」状态，可选提示音。
- **结束时给出汇总。** 做完最后一题后，结束页会多出一张卡片，列出本轮每道题的用时。
- **数据只留在本机。** 记录保存在浏览器本地存储里。扩展**不发起任何网络请求**，
  不会把任何信息发送到任何地方。

它**不会**替你答题、提交答案、跳过题目，也不会改变你在可汗学院的进度或成绩。
它只判断「当前是哪道题」以及「这道题停留了多久」。

### 运行环境

| | |
|---|---|
| 浏览器 | **Google Chrome 114+** 或 **Microsoft Edge 114+**（同为 Chromium 内核，同一个 ZIP 两边都能用；其他 Chromium 浏览器通常也行，但只在 Chrome 与 Edge 上验证过） |
| 电脑 | Windows / macOS / Linux 桌面版。手机和平板无法安装扩展。 |
| 生效范围 | `khanacademy.org` 上的练习页与测验页 |
| 可汗学院账号 | 计时器本身不需要登录 |

### 安装（2 分钟）

本扩展**没有**上架 Chrome 应用商店或 Edge 加载项商店，所以要从 Releases 页面下载后手动安装。
整个过程大约两分钟，只需要做一次。

#### 1. 下载 ZIP

打开发布页面：

**<https://github.com/pizht/Khan-Timer/releases/latest>**

在 **Assets** 下点击名为 `khan-timer-<版本号>.zip` 的文件（例如 `khan-timer-0.3.0.zip`）。

> **不要**下载 "Source code (zip)" 或 "Source code (tar.gz)" —— 那是源码压缩包，装了没用。

#### 2. 解压到一个你不会删掉的文件夹

把下载的 ZIP 解压（Windows / macOS 双击即可）到一个固定的位置，例如
`文档\khan-timer` 或 `~/Documents/khan-timer`。

打开这个文件夹，确认 `manifest.json` **就在这一层**，与 `content.js`、`popup.html`、
`icons`、`_locales` 并列：

```text
khan-timer/
├── manifest.json     ← 这个文件必须直接在这个文件夹里
├── content.js
├── popup.html
├── popup.js
├── popup.css
├── icons/
└── _locales/
```

如果里面只有一个同名的子文件夹，就再进一层；如果 `manifest.json` 在 `dist` 文件夹里，
那 `dist` 就是你要选的文件夹。

> **请让这个文件夹留在原地。** 浏览器每次启动都从这里加载扩展；移动或删除它，计时器就失效了。

#### 3. 打开扩展管理页

| 浏览器 | 地址 |
|---|---|
| Chrome | `chrome://extensions` |
| Edge | `edge://extensions` |

在地址栏输入后回车。

#### 4. 加载扩展

1. 打开 **开发者模式** —— Chrome 在右上角，Edge 在左侧栏；
2. 点击 **加载已解压的扩展**（Load unpacked）；
3. 选择第 2 步的文件夹（含 `manifest.json` 的那个），确认。

列表里会出现一张名为 **Khan Academy Timer** 的卡片。如果提示
*「Manifest file is missing or unreadable」*（清单文件缺失或无法读取），说明选错了文件夹，
回到第 2 步。

#### 5. 固定到工具栏（建议）

点击地址栏右侧的拼图图标，把 **Khan Academy Timer** 固定到工具栏。
设置面板与实时状态都从这个图标打开。

#### 6. 试一下

打开任意练习页，例如：

```text
https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4
```

页面右上角会出现「题目计时」悬浮面板并开始计时。

> **浏览器之后可能会提示两件事**
>
> - Chrome / Edge 启动时可能弹出关于「开发者模式扩展」的提示，请选择**保留**它们的选项
>   （通常是*取消*或*保留*）。如果选了「停用」，计时器会被关掉，需要回扩展管理页重新打开。
> - 扩展可能被标注为「已解压」之类的状态，这是这种安装方式的正常现象，也是 ZIP
>   必须留在你磁盘上的原因。

### 升级到新版本

1. 在同一个[发布页面](https://github.com/pizht/Khan-Timer/releases/latest)下载新的 ZIP；
2. 解压后把文件**覆盖到原来的文件夹**（全部替换），文件夹路径保持不变；
3. 打开 `chrome://extensions` 或 `edge://extensions`，在 Khan Academy Timer 卡片上点击
   **重新加载**（↻）；
4. 刷新可汗学院页面。

因为扩展仍然从同一个文件夹加载，**设置与历史记录都会保留**。

> 如果你更想解压到一个**新**文件夹：请先在扩展管理页移除旧的那份，否则同一个页面上会同时
> 跑两个计时器。另外，新文件夹意味着新的扩展身份，设置与历史记录会从零开始。

### 卸载

1. 打开 `chrome://extensions` 或 `edge://extensions`；
2. 在 Khan Academy Timer 卡片上点击**移除**并确认；
3. 删掉你解压出来的文件夹（已经不需要了）。

移除扩展会连同它保存的设置与历史记录一起从浏览器中删除。
如果你只是想清掉记录、还想继续用，请改用弹出面板里的**清除全部记录**。

### 使用

#### 面板什么时候出现

| 页面 | 表现 |
|---|---|
| 已加载出题目的练习页 | 显示面板并开始计时 |
| 已加载出题目的测验 / 单元测试 | 显示面板并开始计时 |
| 第 1 题之前的「Ready to practice?」起始卡片 | 不显示 —— 还没有题目，没有可计时的对象 |
| 课程目录页、视频页、文章页 | 不显示 —— 这些页面没有题目 |
| 练习结束页 | 不显示面板，改为插入「本轮每题用时」卡片 |

面板跟随的是**题目**而不是页面：页面一旦报出「这是第几题」，面板才出现，
所以不会出现一个量不出东西的时钟。

#### 悬浮面板

| 部位 | 作用 |
|---|---|
| 时间读数 | 当前题目的用时，格式 `m:ss` |
| 模式标签 | `正计时` 或 `倒计时` |
| `限时 60s` / `超时 +0:12` | 倒计时模式下的限时，以及超出的时间 |
| `题目进度 1 of 4` | 当前是这一套题里的第几题 |
| **暂停** / **继续** | 暂停或恢复本题计时 |
| **重置本题** | 只把**当前题**归零，不影响其他题目与已保存记录 |
| `–` 按钮 | 把面板折叠成只显示时间的小胶囊，点胶囊可展开 |
| 拖动标题栏 | 把面板拖到任意位置，位置会被记住 |
| `已完成` / `已暂停` 标记 | 答对、跳过后或暂停时显示 |

倒计时模式下时间用尽时，面板变红并显示超时（例如 `超时 +0:12`）。
**不会**自动提交答案、也不会自动跳题 —— 它只是给你的提示。

#### 什么时候停表

| 你的操作 | 计时 |
|---|---|
| 答对并点 **Check** | 停止，面板显示 `已完成` |
| 答错 | 继续 —— 可以重试 |
| 点 **Skip** 后确认 **Yes, skip** | 停止 |
| 点 **Skip** 后点 **Cancel** | 继续 |
| 输入答案、展开提示、选中选项 | 继续 |
| 切到下一题 | 结算上一题，新题从 `0:00` 开始 |

#### 结束页的「本轮每题用时」

做完一套题的**最后一道题**、可汗学院显示结束页后，结果上方会多出一张卡片：

```text
本轮每题用时                                    共 3 题 · 合计 0:12
──────────────────────────────────────────────────────────────────
题目                                              用时
第 1 题  答对                                     0:04
第 2 题  已跳过                                   0:05
第 3 题  答对                                     0:03
```

- 点击标题（或标题左侧的小箭头）可折叠 / 展开，折叠状态会被记住。
- 每行显示题号、`答对` / `答错` / `已跳过` / `超时` 标记与用时。没有计时数据的题号会显示
  `数据缺失`，而不会把下一题的用时顶上来。
- 某一题中途暂停过，会在用时下方以小字标注 `暂停 0:05`；暂停时间不计入合计。
- 卡片插在可汗学院原有内容之前，**不会遮住**页面上任何已有信息。
- 两点实际情况：卡片只在真正的结束页出现（要先把所有题做完，包括加试题）；
  而未登录时，可汗学院通常不会显示结束页。

### 设置

点击工具栏图标打开弹出面板。上方的卡片显示当前标签页的实时状态，中间的卡片是设置。
**改动立即生效** —— 弹出面板、页内悬浮面板、已经打开的页面都会同步。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| **语言** | 跟随浏览器 | 界面语言：跟随浏览器 / English / 中文（简体）。跟随浏览器时，中文浏览器显示中文，其他语言回落英文。 |
| **默认计时模式** | 正计时（记录用时） | 新题开始时使用的模式。 |
| **每题限时（秒）** | 60 | 倒计时的时长，可填 5–3600。 |
| **倒计时归零时播放提示音** | 开 | 由浏览器现场合成的两声短音，不下载任何音频文件。 |
| **在页面上显示悬浮面板** | 开 | 总开关。关掉后面板隐藏，但计时仍在后台进行。 |
| **面板默认折叠为小胶囊** | 关 | 面板一开始就是小胶囊，点击可展开。 |
| **关闭页面后重新打开时，继续上次用时** | 开 | 重新打开同一道题时接着上次的累计用时继续，而不是从零开始。 |
| **开发者模式** | 关 | 在弹出面板与悬浮面板里显示识别细节。反馈问题时有用，日常不需要开。 |

### 历史记录

弹出面板最下方的**历史记录**卡片会列出最近的记录：题号（`2/4`）、用时、是否超时，
以及第一次提交的对错。

- 最多保留最近 **500** 条，超出后自动丢弃最旧的。
- **清除全部记录**只删记录，**不影响设置**；没有记录时该按钮不显示。
- 题目原文与你输入的答案都不会保存，只保存计时数据和题目的本地短指纹。

### 你的数据与隐私

- **所有数据都在你的电脑上。** 记录保存在扩展自己的浏览器本地存储中：没有账号、
  没有服务器、没有统计上报。
- **扩展没有能力把数据发出去。** 它的代码里完全没有任何网络调用 —— 没有 `fetch`、
  没有 `XMLHttpRequest`、没有 WebSocket、没有远程脚本。每次构建都会自动检查这一点
  （61 项检查，其中包含扫描构建产物里的网络调用与动态执行代码）。
- **只申请两个权限：**

  | 权限 | 用途 |
  |---|---|
  | `storage` | 在本机保存设置与计时记录 |
  | `activeTab` | 让弹出面板读取你当前标签页的计时状态 |

  它读不到你的浏览历史、Cookie、密码、剪贴板或文件，而且只在 `khanacademy.org` 上运行。
- **彻底删除：** 在弹出面板里清除记录，或在扩展管理页移除本扩展 —— 移除会连同它的本地
  数据一起删除。
- 本扩展与可汗学院（Khan Academy）没有隶属关系，也未获得其认可或授权。

### 疑难解答

| 现象 | 处理办法 |
|---|---|
| 加载时提示 *「Manifest file is missing or unreadable」* | 选错了文件夹。请选择**直接包含** `manifest.json` 的那一层（见[第 2 步](#2-解压到一个你不会删掉的文件夹)）。 |
| 练习页上没有面板 | 确认页面上真的有题目（「Ready to practice?」卡片不算题目），然后刷新页面；再到 `chrome://extensions` / `edge://extensions` 确认扩展仍处于启用状态。 |
| 面板突然消失，弹出面板显示「未识别到题目」 | 这是**预期行为**：此刻页面没有报出「这是第几题」。计时被**暂停**（这段时间不计入本题），同一道题重新可识别后会自动继续，这道题也不会丢 —— 结束页卡片里仍然有它那一行。如果一直不恢复，说明该页面类型尚未适配。 |
| 题目一开始就带着一段用时 | 这是「关闭页面后重新打开时，继续上次用时」的效果（离开练习再回来也一样）。想从零开始就点**重置本题**，或关闭该设置。 |
| 倒计时归零没有声音 | 浏览器在用户与页面交互之前会阻止音频。先点一下页面任意位置再试。 |
| 重启浏览器后计时器不见了 | 可能是开发者模式扩展的提示把扩展停用了。到扩展管理页重新启用，并在下次出现提示时选择*保留*/*取消*。 |
| 升级后设置和历史记录空了 | 说明扩展是从另一个文件夹加载的，属于另一份安装。下次请覆盖到**同一个**文件夹。 |
| 面板显示「置信度：弱信号」，或切题没被识别 | 该页面没有提供计时器通常依赖的进度标记。手动切题时请点**重置本题**；也欢迎把页面反馈给我们。 |
| 结束页没有出现用时卡片 | 卡片只在整套题（含加试题）做完后的真正结束页出现；而未登录时，可汗学院通常不显示结束页。 |
| 同时出现两个面板 / 两个计时器 | 你装了两份。到扩展管理页移除其中一份。 |

### 常见问题

**它会替我答题或提交吗？**
不会。它只观察当前是哪道题，不会点 Check、不会选中答案，也不会跳过题目。

**会影响我在可汗学院的进度或成绩吗？**
不会。

**数据会被上传吗？**
不会。扩展不发起任何网络请求。你也可以自己验证：构建产物刻意不做压缩，
而且一旦出现网络调用，构建就会直接失败。

**登录状态下能用吗？**
能。登录只影响可汗学院自己的结束页（见上文）。

**需要账号或者联网吗？**
不需要账号；安装完成后计时功能离线也能用。

**测验、单元测试、课程挑战能用吗？**
扩展会尝试识别任何可汗学院练习 / 测验页面上的题目。验证最充分的是练习页；
不支持的页面会在弹出面板里明说，而不会假装正常工作。

**Chrome 和 Edge 能同时用吗？**
可以 —— 同一个 ZIP 在两个浏览器里分别安装即可，各自的设置与历史记录互相独立。

**Firefox、Safari、手机或平板能用吗？**
不能。它面向 Chromium 内核的桌面浏览器（Chrome、Edge 等）。

**怎么知道自己是哪个版本？**
弹出面板标题右侧显示 `v<版本号>`，例如 `v0.3.0`。

### 反馈问题

请在 **<https://github.com/pizht/Khan-Timer/issues>** 提交 issue，并附上：

1. 浏览器名称与版本；
2. 弹出面板标题处显示的扩展版本；
3. 出问题的练习页地址；
4. 弹出面板「当前状态」卡片里的内容 —— 先在设置里打开**开发者模式**，
   它才会显示识别方式、置信度、题目指纹、最近事件等细节。

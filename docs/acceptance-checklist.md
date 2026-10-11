# 验收标准对照表

逐条对照需求文档 **第 8 节「验收标准」** 与 **第 10 节「交付物」**，
给出状态、证据与复现命令。

**状态图例**

| 标记 | 含义 |
|---|---|
| ✅ | 已满足，且有可复现的机器证据 |
| ⚠️ | 部分满足 / 有保留 |
| ❌ | 未满足 |

复现命令（在本项目根目录）：

```bash
pnpm install
pnpm run verify          # 类型检查 + 单元测试(205) + 构建 + dist 产物检查(56)
pnpm run verify:edge     # 真实 Edge 端到端验证(74)
```

---

## 8.1 安装与界面

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 可在支持的 Edge 桌面版通过「加载解压缩的扩展」成功安装 | ✅ | `scripts/verify-extension.mjs` 用 `--load-extension=dist` 把 `dist/` 作为解压扩展加载进 **真实 Microsoft Edge 154.0.4258.62** 并成功运行（67/67）。`scripts/verify-dist.mjs` 确认 `dist/` 内 `manifest.json` 为 Manifest V3 且所有被引用文件存在。安装步骤见 `README.md` → 安装到 Edge。 |
| 2 | 在目标 Khan Academy 页面显示悬浮计时面板 | ✅ | 检查项 `content script injects the panel host`、`panel is visible`、`the detected question is reported in the panel`（实测 `进度 1 of 4 识别：题目ID`）。截图 `references/screenshots/overlay-countup.png`。 |
| 3 | 面板可正常折叠/展开或以已约定方式隐藏 | ✅ | 收集 `onToggleCollapse` → 折叠为小胶囊；截图 `references/screenshots/overlay-collapsed.png`。另有弹出面板的「在页面上显示悬浮面板」总开关。 |
| 4 | 面板操作不会触发题目识别器错误重置计时 | ✅ | 面板挂在 `document.body` 的 Shadow DOM 宿主 `#khan-academy-timer-host` 内，位于题目区域之外；检测器的指纹计算还会剔除该宿主与 `[role="dialog"]`/`[aria-live]`。端到端实测：连续点击暂停/继续/重置后，`reset is reported in the panel footer`（`题目未变化，计时继续`）——重置未被识别为切题。单元测试 `typing an answer into the widget is NOT a question change` 等同类回归用例共 4 条。 |

## 8.2 计时功能

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 正计时模式进入已验证新题后自动开始 | ✅ | 检查项 `countup mode is active by default`、`the detected question is reported in the panel`（面板页脚 `检测到新题目，计时开始`）。单元测试 `emits an initial question-changed with from === null`。 |
| 2 | 倒计时模式使用用户配置的限时开始 | ✅ | 检查项 `popup writes settings to chrome.storage.local`（`countdownLimitSeconds: 6`）、`countdown mode applies live to the current question`（`mode=倒计时`）、`countdown reaching zero shows a visible timeout state`（`限时 6s`）。 |
| 3 | 暂停后计时数值不继续增加；继续后正确恢复 | ✅ | 检查项 `paused time does not accumulate`（`0:03 → 0:03`，等待 2.5 s）、`resume continues accumulating from the paused value`（`0:03 → 0:05`）。单元测试 `freezes the value while paused and resumes from the frozen value`。 |
| 4 | 重置只影响当前题目计时 | ✅ | 检查项 `reset returns the current question to ~0`（`0:00`）；`reset is reported in the panel footer` 且题目标识未变（`进度 1 of 4` 不变），已保存记录数不受影响。 |
| 5 | 倒计时结束后显示超时状态，但不会自动提交答案或切题 | ✅ | 检查项 `countdown reaching zero shows a visible timeout state`（`status=status-expired`，`超时 +0:10`，面板数值转红）、`timeout does not navigate away or submit anything`、`the timeout state is announced in the panel`。截图 `references/screenshots/overlay-countdown-expired.png`。实现上超时只置一个 `expired` 标记并播一次提示音，没有任何提交或导航代码路径。 |
| 6 | 切换题目时保存上一题记录，并启动新题计时 | ✅ | 检查项 `advancing to a new question restarts the timer`（`0:04 → 0:03`）、`the question identity changed on advance`（`进度 1 of 4 → 2 of 4`）、`a record was saved for the finished question`（`已记录 1`）。 |
| 7 | 同一个题目变化事件被重复触发时，不产生重复记录或多重计时器 | ✅ | 单计时器设计：`ContentController` 只持有**一个** `TimerEngine`。单元测试：`suppresses duplicates: many observations of one change yield one event`（50 次观察 → 1 次切换）、`does not switch on an A -> B -> A flap`、`respects the cooldown between two accepted changes`。引擎侧 `markFirstSubmission` 只记第一次。 |
| 8 | 浏览器标签短暂进入后台或电脑休眠后，恢复时的时间计算符合产品规则 | ✅ | 计时完全由时间戳差分得出，不依赖 `setInterval` 触发次数。单元测试 `accumulates elapsed time across a large clock jump without any ticks`（**1 小时无 tick**）、`computes the exact expiry instant instead of the tick time`（延后一小时才发现，归零时刻仍精确）。产品规则（真实时间 vs 关闭页面冻结）见 `README.md` → 时间语义。 |

## 8.3 识别与兼容性

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 对已验证的每种页面类型，至少测试连续完成 10 次题目切换 | ❌ **未满足** | 实际完成 **3 次**连续切题（未加载扩展的交互采集，进度索引 0→1→2→3，见 `references/observations.md` 第 1 节）与 **1 次**（加载扩展的端到端）。用于验证的练习只有 4 题且每次切题须先答对，自动化上限受题量限制。**如实记录于 `docs/known-limitations.md` 第 1 条。** |
| 2 | 输入答案、打开提示、显示答题反馈、展开辅助内容时，不应无条件重置题目计时 | ✅ | 4 条专门回归用例（`tests/question-detector.test.ts` → `REGRESSION — auxiliary content must not reset the timer`）：输入答案、答错浮层、**提示展开使区域文本 3.5 KB→23 KB**、无进度标记时的反馈浮层。端到端另有实测：**答对后停表**（`answering correctly stops the timer`）与**答错后继续计时**（答错时不停表，可重试）。真实观测依据见 `references/observations.md` 第 2、3、4 节。 |
| 3 | 无法可靠识别时提供可见提示或可用的手动恢复方式 | ✅ | 检测器发出 `uncertain` 后：**暂停**本题计时并**隐藏**面板（不再显示一个量不出东西的时钟），扩展弹出面板给出可见提示（`未识别到题目（question region not found）。本题计时已暂停，重新识别到本题后会自动继续。`）、「识别」一栏显示 `未识别/弱信号`；重新识别到**同一道题**后自动继续计时，且本题仍会出现在结束页的用时统计里。单元测试 `degrades conservatively when no question region is found`、`keeps the current timer when the identity disappears mid-question`、`hides the panel, freezes the clock and resumes the same question from the frozen value`、`keeps a question paused mid-way in the end-of-exercise summary`。详见下方「追加修正：识别：未识别时暂停计时并隐藏面板」。 |
| 4 | 验收清单明确列出已验证支持和未验证的页面类型 | ✅ | `docs/compatibility.md`（验收视角）与 `references/page-inventory.md`（研究视角），按 `Edge-verified` / `Automated-tested` / `Observed` / `Unverified` 四级列明。 |

## 8.4 数据与隐私

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 设置与计时记录保存在本地 | ✅ | 全部通过 `chrome.storage.local`，实现在 `src/storage.ts`。端到端检查项 `popup page opens and reaches chrome.storage`、`popup writes settings to chrome.storage.local`、`popup reports the saved timing records`（`已保存 1 条`）。单元测试 `tests/storage.test.ts` 共 29 条。 |
| 2 | 关闭并重新打开页面后，配置仍然保留 | ✅ | 单元测试 `survives a page reload by reading back from storage`。进行中的题目会话也有覆盖：`round-trips a running session and continues from the saved elapsed time`。 |
| 3 | 能清除保存的计时记录 | ✅ | 端到端检查项 `clearing records removes them from local storage`（`已保存 0 条`）与 `clearing records leaves settings intact`（设置保留）。单元测试 `clears records but leaves settings alone (spec 8.4)`。UI 入口：弹出面板「清除全部记录」。 |
| 4 | 网络检查/代码审查确认没有计时数据上传或非必要遥测 | ✅ | `scripts/verify-dist.mjs` 对 `dist/*.js` 逐项断言**不存在** `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / `eval` / `new Function` / `importScripts` / 动态插入 `<script>` / 外部 http(s) 地址，并检查 source map 存在。构建**刻意不压缩**以便人工审查。项目源码中没有任何网络调用。 |
| 5 | 扩展权限与本项目范围一致 | ✅ | 只声明 `storage` 与 `activeTab`；`verify-dist.mjs` 断言权限在允许清单内、**无** `host_permissions`、**无** `optional_permissions`、**无** background worker、**无** `web_accessible_resources`，且内容脚本只匹配 `khanacademy.org`（拒绝 `<all_urls>`）。权限逐条用途见 `README.md` → 权限说明。 |

**8.4 小结：5 / 5 满足。8.1：4 / 4。8.2：8 / 8。8.3：3 / 4（连续 10 次切题未满足）。**

---

## 追加需求（本轮变更）

在本文件原有的验收标准之外，用户又提出三项行为变更。它们与验收标准的
8.2（计时功能）和 8.3（识别与兼容性）直接相关，因此一并记录。

| # | 需求 | 状态 | 证据 |
|---|---|---|---|
| 1 | 点击 Skip 后停止本题计时 | ✅ | 只有**确认**跳过才停表（点 Cancel 不停）。真实 Edge 端到端：`skip asks for confirmation first`、`the skip confirmation can be triggered`、`confirming a skip stops the timer`（`0:04 → 0:05`，随后 3.5 s 保持不变）、`answering after a skip does not resume the stopped timer`。规则由纯函数 `completionTriggerFor()` 实现，单元测试覆盖「答错不停」「确认跳过才停」「取消不停」等 6 种情形。 |
| 2 | 点击 Check 判定正确后停止本题计时 | ✅ | 真实 Edge：`the page accepted the correct answer`（`state=correct`）、`answering correctly stops the timer`（`status-finished`）、`the panel shows the completed state`、`the pause control is disabled once the question is done`、`the frozen value does not creep upwards afterwards`（3.5 s 后仍为 `0:04`）。答错时**不停表**（可重试），由 `completionTriggerFor()` 与单元测试保证。 |
| 3 | 做完所有题后点击 `Show summary`，在结束页显示本轮每题用时 | ✅ | 真实 Edge：`the end-of-exercise summary screen is reached`、`the summary card is injected`、`the summary lists every question of this run`、`each summary row shows a duration`、`the summary shows a total`、`the summary marks the skipped question`。实测卡片内容：`本轮每题用时 / 共 3 题 · 合计 0:15 / 第 1 题答对 0:04 / 第 2 题已跳过 0:05 / 第 3 题 0:06`。 |

### 追加修正：计时面板应当只在有题目时显示（用户报告）

| 项目 | 内容 |
|---|---|
| **要求** | 面板显示与题目识别状态同步：未识别时不显示，识别到题目时显示 |
| **实现** | `shouldShowPanel()`：仅当 `overlayVisible` 为真、不在结束页、**且 `engine !== null`**（即确实在给某道题计时）时显示。识别临时不确定时**不显示**，并同时暂停本题计时（见下一条追加修正） |
| **顺带修复** | 测验 / 单元测试 / 课程挑战页面的「介绍卡片」（`data-testid="start-task-card-summary"`）会让结束页判定**误报为 true**（外观同样是「有练习外壳、无答题表单、无进度标记」）。已按该 testid 排除，并新增 `isStartCardPresent()` 让弹出面板提示「尚未开始：请点击页面上的「Let's go」」 |
| **可见提示的落点** | 识别失败时面板不显示，原因改由**扩展弹出面板**呈现（未找到题目区域、命中策略、错误列表），满足需求 8.3「提供可见提示**或**可用的手动恢复方式」 |
| **单元测试** | `isSummaryPage` 新增「介绍卡片不算结束页」用例；新增 `isStartCardPresent` 3 条 |
| **端到端** | 新增 6 项真实 Edge 检查：课程页无面板、测验介绍卡片上无面板、点 `Let's go` 后识别到题目（进度 5）、随后面板出现并显示 `进度 1 of 5 识别：题目ID` |

### 追加修正：识别：未识别时暂停计时并隐藏面板（用户报告）

| 项目 | 内容 |
|---|---|
| **要求** | 状态为「识别：未识别」时**不显示**计时小面板，并**暂停**当前题目的计时；直到识别到**被暂停的那道题**时才继续原先的计时；并且这道中途被暂停的题目，在做完整个 practice 后**仍然要被结束页的用时统计列表收录** |
| **实现** | `ContentController` 新增两个状态位：`unidentified`（页面当前给不出可用标识）与 `autoPausedForIdentity`（本题的时钟是**扩展自己**因为识别丢失而暂停的）。`shouldShowPanel()` 增加 `!unidentified` 分支；`pauseForMissingIdentity()` 在识别丢失时调用 `engine.pause(now, /* automatic */ true)`——**只暂停、不丢弃**引擎；`resumeAfterIdentityRestored()` 只在事件携带的标识**等于 `engine.questionKey`** 时 `engine.resume()` |
| **为什么是暂停而不是丢弃** | 丢弃/重置会让这道题**从结束页消失**。暂停保留了引擎、`accumulatedMs`、第一次提交时间戳与 `runId`；无法识别的那段时间只累加 `pausedMs`，因此本题既能继续计时，也照样生成记录 → 照样出现在结束页表格里 |
| **只恢复自动暂停** | `autoPausedForIdentity` 只在自动暂停时置位，学生手动按「暂停」时清除。识别恢复后，学生自己的暂停**保持暂停**（`never undoes a pause the learner asked for`） |
| **记录语义** | `TimerEngine.pause(now, automatic)`：`automatic` 为真时不再置 `sawPause`（协调器在识别丢失时传 `true`），所以记录的 `wasPaused` 仍然只表示「学生按过暂停」；无法识别的时间只体现在 `pausedMs`（结束页该行会多一行小字 `暂停 0:31`） |
| **顺带修复的真实缺陷** | 题目区域被换掉再**原样**换回来时，进度标记没有变、新区域里也没有任何 mutation，检测器原本不会再评估一次，于是会永远停在「未识别」（面板一直不回来）。`QuestionDetector.onBodyMutation()` 现在在**重新绑定到区域的那一刻立即评估**，并新增回归用例 |
| **可见提示的落点** | 面板隐藏，所以提示改由**扩展弹出面板**呈现：`未识别到题目：本题计时已暂停，重新识别到本题后自动继续`（`pausedForUnidentified` 字段） |
| **单元测试** | `TimerEngine`：`an automatic pause freezes the clock without claiming the learner paused it`、`a learner pause still marks the question as paused`。检测器：`re-evaluates the moment the region comes back, with nothing else changing`。协调器（jsdom 端到端）：`hides the panel, freezes the clock and resumes the same question from the frozen value`、`never undoes a pause the learner asked for`、`keeps a question paused mid-way in the end-of-exercise summary`、`matches the manual verification recipe in the README (remove then restore the region)`（最后一条与 README 的手动验证步骤逐字对应） |
| **端到端** | **未在真实 Edge 上驱动验证**：浏览器里无法可靠制造「题目区域消失、进度标记不动、随后同一道题原样回来」这一幕。证据为 jsdom 端到端（真实协调器 + 真实检测器 + 真实存储逻辑，仅 DOM 与 `chrome.storage` 为替身），见 `tests/controller.test.ts`。这一保留已记入 `docs/known-limitations.md` 第 23 条 |

### SAT test-prep 页面类型

实测 `/test-prep/v2-sat-math/...` 的四类页面（练习、测验、单元测试、课程挑战），
开始答题后与已验证的普通练习页**结构完全一致**，**无需新增选择器**。
详见 [`references/observations.md`](../references/observations.md) 第 12 节与
[`docs/compatibility.md`](compatibility.md) 第 1.4 / 1.5 节。

### 追加修正：答错后重答正确没有停表（用户报告）

| 项目 | 内容 |
|---|---|
| **现象** | 第一次答错、第二次点 `Check again` 答对时，本题计时没有停止 |
| **根因** | 可汗学院的进度标记保留的是**第一次作答**的判定。先答错再答对时，标记始终停在 `exercise-progress-<i>-incorrect-current`，**不会**变成 `correct`。原实现只监听「状态字变为 correct」，因此重答正确时没有任何事件，计时一直跑 |
| **修复** | 增加第二个互补信号：**`Check` 按钮被「下一题」控件取代**（`isQuestionFinished()`，即 `exercise-next-question` 存在且 `exercise-check-answer` 不存在）。该信号覆盖「任意一次答对」，包含重答 |
| **覆盖** | 状态字变 `correct` → 首次就答对（观察器触发，<250 ms）；按钮替换 → 任意一次答对（受节流的页面检查，≈700 ms）。两者幂等：先触发者写入待写记录，后触发者因 `pendingRecord !== null` 直接返回 |
| **单元测试** | `isQuestionFinished` 6 条（含「答错后为 false」「重答正确为 true」「过渡态两按钮并存为 false」）+ 2 条说明「重答正确无法由状态字发现」 |
| **端到端** | 新增真实场景：先提交错误答案（正确值 +7）→ 断言计时**继续** → 再提交正确答案 → 断言计时**停止**且 3.2 s 后冻结。实测输出：`state=incorrect finished=true`、`status=status-finished time=0:07`、`0:07 -> 0:07` |

顺带确认：这类题目的记录里 `firstSubmissionOutcome` 仍是 `incorrect`，
结束页表格显示「答错」—— 这与需求 2.4「保存第一次提交答案的时间戳」一致，
标记的是**第一次提交**的结果，而不是这题最终有没有做对。

### 相关的采集与设计修正

- **发现 `addition_4` 有 bonus question。** 最后一道普通题之后的控件文案是
  `Bonus question`（进入加试题，进度索引回到 0），加试题之后才是 `Show summary`。
  这一发现修正了早期「索引倒退＝练习重做」的误读，并已在
  `references/observations.md` 第 10.1、10.1.1 节更正。
- **结束页表格按答题顺序编号**，索引倒退的那一行标记为「加试」，
  避免表格里出现两个「第 1 题」。
- **结束页判定用结构不变式**（无答题表单 + 练习外壳仍在），不依赖只在未登录时出现的
  `eot-phantom-user-registration`。登录态的插入位置未验证，见已知限制第 15 条。

### 本轮修复的真实缺陷（均由真实 Edge 验证发现）

| 缺陷 | 症状 | 修复 | 回归测试 |
|---|---|---|---|
| 进度观察器未绑定 | 页脚在题目区域之后才出现，观察器从未创建；「答对/跳过」的状态变化只能靠偶发的区域变更被发现，导致记录整条丢失 | `poll()` 在观察器缺失时补绑定 | `attaches the progress observer even when the footer appears late` |
| 去抖复核可被饿死 | 每次 `pending` 事件都重排复核定时器，变更可能永不提交 | 已排队就不再重排 | `confirms a pending change even when mutations keep arriving (no starvation)` |
| 首次提交对错读不到 | 用 350 ms 定时器读反馈，早于页面更新，记录里对错全是 `unknown` | 改用进度状态变化作为权威信号 | `readSubmissionOutcome` 系列 + 端到端 `outcome: "correct"` |
| 加载中误判结束页 | 页面尚未渲染题目时「无答题表单 + 有练习外壳」成立，被当成结束页 | 必须真的计时过一道题才允许进入结束页 | `isSummaryPage` 系列 |
| 僵留的待写记录阻塞下一题 | 一旦漏检一次切题，上一题的待写记录会让下一题无法结算，整行丢失 | 索引不同则先落盘旧记录再结算新题 | 由端到端记录数验证 |
| 切换练习丢掉进行中的计时 | 可汗学院是单页应用，换练习只换地址、不重新加载页面：旧练习的计时器没有被收掉，面板带着旧读数出现在新练习的「Ready to practice?」页并继续增长；如果新练习停在同一进度（都是「1 of N」），新题会被当成「题目没变」，旧练习那份进行中的会话随后被当成一次普通切题结算掉，回到旧练习时已累计用时归零、待写记录也没了 | 地址一变就作废旧题目身份（`syncUrl()`，且在 `evaluate()` 里而不只在轮询里，避免新页面的变更先于地址检查被提交）；只要页面已不属于当前练习就把本题**暂存**：冻结时钟、按 `session:<练习路径>` 保留可续接的会话、已答对/跳过的待写记录立刻落盘；面板只在当前练习的页面上显示 | `tests/controller.test.ts`（3 例，jsdom + 内存版 `chrome.storage.local`）、`treats an SPA move to another exercise as a new question, not a continuation`、`tests/storage.test.ts` 的会话冻结用例 |

---

## 第 9 节 测试计划覆盖情况

需求文档第 9 节列出 12 个必须包含的测试场景。

| # | 场景 | 覆盖 | 方式 |
|---|---|---|---|
| 1 | 新开已支持的练习页面 | ✅ | 端到端（`content script injects the panel host` 等） |
| 2 | 自动进入下一题 | ✅ | 端到端 `advancing to a new question restarts the timer` |
| 3 | 使用页面提供的上一题/下一题导航 | ⚠️ | 已验证页面无「上一题」控件；「下一题」已覆盖。上一题路径仅有单元测试（`forceSwitch` / 索引变化）。 |
| 4 | 输入答案但尚未提交 | ✅ | 单元测试 `typing an answer into the widget is NOT a question change` |
| 5 | 提交答案并出现正确/错误反馈 | ✅ | 端到端提交；真实采集观测了答对/答错两种浮层（`references/observations.md` 第 2 节）；`readSubmissionOutcome` 单元测试 |
| 6 | 展开提示、解释或辅助内容 | ✅ | 专门回归用例 `hint expansion that grows the region 3.5 KB -> 23 KB is NOT a question change` |
| 7 | 同一道题触发多次 DOM 变化 | ✅ | 单元测试 `suppresses duplicates…`（50 次观察）、`does not switch on an A -> B -> A flap` |
| 8 | 正计时暂停、恢复和重置 | ✅ | 端到端 3 项 + `tests/timer-engine.test.ts` |
| 9 | 倒计时暂停、恢复、归零及提示音开关 | ✅ | 端到端超时 3 项；单元测试 `fires expiredJustNow exactly once so the tone cannot repeat`（提示音只响一次）、`resolves expiry correctly when the limit passes while paused`；提示音开关在弹出面板并有端到端写入验证 |
| 10 | 页面刷新、标签页切换、浏览器休眠后恢复 | ⚠️ | 刷新由单元测试覆盖（会话恢复 + 配置持久化）；**在同一个标签页里切换练习**由 `tests/controller.test.ts` 覆盖（离开时冻结并保留会话、回来后接着计时、已答对的题立刻落盘）；休眠由「大跨度时钟跳跃」单元测试覆盖。**真实休眠未实测**（见已知限制第 7 条）。 |
| 11 | 本地存储为空、已有记录或写入失败 | ✅ | `tests/storage.test.ts` 全覆盖：空存储、有记录、`failOnSet` / `failOnGet` / `failOnRemove`、无 `chrome` API、数据损坏清洗 |
| 12 | 页面结构变化导致无法找到题目区域时的降级处理 | ✅ | 单元测试 `goes uncertain, and keeps timing, when the region disappears`、`hides the panel, freezes the clock and resumes the same question from the frozen value`、`re-evaluates the moment the region comes back, with nothing else changing`；截图 `overlay-degraded-unrecognised.png`（**历史截图**：拍摄于「保持计时」的旧行为下，现行为是隐藏面板并暂停，见下方追加修正） |

**12 个场景中 10 个完全覆盖，2 个（#3、#10）部分覆盖并已如实记录。**

---

## 第 10 节 交付物清单

| # | 要求 | 状态 | 位置 |
|---|---|---|---|
| 1 | 完整 TypeScript 源代码 | ✅ | `src/`（12 个文件）；`pnpm run typecheck` 在 `strict` + `noUncheckedIndexedAccess` 下通过 |
| 2 | 可由 Edge 加载的构建输出目录 `dist/` | ✅ | `dist/`（332 KB）；`pnpm run build` 生成；`verify-dist.mjs` 56 项检查通过；已被真实 Edge 加载 |
| 3 | `manifest.json` 与最小必要图标资源 | ✅ | `public/manifest.json` → `dist/manifest.json`；图标 16/32/48/128 px，由 `scripts/make-icons.mjs` 用 Node 内置模块生成（无图像依赖），`verify-dist.mjs` 校验为真实 PNG 且尺寸匹配 |
| 4 | `README.md`：环境准备、构建、安装、升级、卸载与常见问题 | ✅ | `README.md`，含全部六项 + 故障排查 |
| 5 | 配置说明：模式、默认限时、提示音、本地数据位置/清除方式 | ✅ | `README.md` → 设置说明 / 本地数据与清除 |
| 6 | 单元测试及其运行说明 | ✅ | `tests/`（7 文件 205 用例）；运行说明见 `README.md` → 测试与验证 |
| 7 | 已验证页面类型清单和人工测试结果 | ✅ | `docs/compatibility.md`；研究依据 `references/page-inventory.md` |
| 8 | 已知限制清单 | ✅ | `docs/known-limitations.md`（23 条，含未满足的验收项、切换练习的边界条件与「识别：未识别」的验证保留） |

---

## 与需求文档「审核清单」（第 13 节）的一致性

| 审核项 | 实现情况 |
|---|---|
| 首版只支持 Microsoft Edge 桌面版 | ✅ 只验证 Edge 154；`minimum_chrome_version: 114` |
| TypeScript + Manifest V3，编译为可加载 JavaScript | ✅ `typescript` + `esbuild`（不压缩 + source map），`src/` 与 `dist/` 严格分离 |
| 倒计时结束只提醒，不自动提交或跳题 | ✅ `expired` 标记 + 一次提示音；无提交/导航代码路径；端到端已验证 |
| 本地保存数据，不使用云同步或账号系统 | ✅ 仅 `chrome.storage.local`；`verify-dist.mjs` 断言无任何网络 API |
| 仅对测试过的页面类型承诺支持 | ✅ `docs/compatibility.md` 分级；`references/page-inventory.md` 明确不承诺未验证页面 |
| 识别不确定时保守降级，不冒险重置计时 | ✅ `uncertain` 事件 → **暂停**本题计时（不重置、不丢弃：引擎与累计用时都保留）+ 隐藏面板 + 弹出面板可见提示；重新识别到同一道题后自动继续，该题仍进入结束页统计。单元测试与截图佐证 |
| 首版包含本地计时记录清除功能与测试清单 | ✅ 弹出面板「清除全部记录」（端到端验证）+ 本对照表与测试清单 |

---

## 「建议默认决定」的落地（第 12 节）

| 建议 | 实现 |
|---|---|
| 标签页隐藏或电脑休眠：按真实经过时间计算，除非手动暂停 | ✅ 时间戳差分；`document.visibilityState === 'hidden'` 时写检查点但**不停表** |
| 倒计时到零：显示超时提醒，不自动提交或切题 | ✅ 见 8.2 #5 |
| 识别不确定：不自动重置；提示用户手动处理 | ✅ 见 8.3 #3：不重置（只是暂停），提示落在弹出面板，重新识别到本题后自动继续 |
| 本地存储：不上传，提供清除功能 | ✅ 见 8.4 #1、#3、#4 |
| 兼容性声明：只对通过测试清单的页面类型做「已验证支持」声明 | ✅ 见 8.3 #4 |

---

## 参考：需求的「建议安装的 npm 包」落实情况

| 包 | 建议 | 实际 | 说明 |
|---|---|---|---|
| `typescript` | 必需 | ✅ 5.9.3 | `pnpm run typecheck` |
| `esbuild` | 必需 | ✅ 0.24.2 | `scripts/build.mjs` |
| `@types/chrome` | 推荐 | ✅ 0.0.287 | 扩展 API 类型 |
| `vitest` | 推荐 | ✅ 2.1.9 | 205 个用例 |
| `jsdom` | 推荐 | ✅ 25.0.1 | DOM 适配器测试环境（`vitest.config.ts`） |

**未引入** React、Vue、任何 UI 组件库、数据库驱动或网络请求库 —— 与需求文档
「我建议首版采用以下配置」一致。额外只加了 `@types/node`（构建脚本用）
与 `@rollup/wasm-node`（见 `README.md` → 故障排查）。

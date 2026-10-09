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
pnpm run verify          # 类型检查 + 单元测试(103) + 构建 + dist 产物检查(56)
pnpm run verify:edge     # 真实 Edge 端到端验证(32)
```

---

## 8.1 安装与界面

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 可在支持的 Edge 桌面版通过「加载解压缩的扩展」成功安装 | ✅ | `scripts/verify-extension.mjs` 用 `--load-extension=dist` 把 `dist/` 作为解压扩展加载进 **真实 Microsoft Edge 154.0.4258.62** 并成功运行（32/32）。`scripts/verify-dist.mjs` 确认 `dist/` 内 `manifest.json` 为 Manifest V3 且所有被引用文件存在。安装步骤见 `README.md` → 安装到 Edge。 |
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
| 2 | 输入答案、打开提示、显示答题反馈、展开辅助内容时，不应无条件重置题目计时 | ✅ | 4 条专门回归用例（`tests/question-detector.test.ts` → `REGRESSION — auxiliary content must not reset the timer`）：输入答案、答错浮层、**提示展开使区域文本 3.5 KB→23 KB**、无进度标记时的反馈浮层。另有端到端实测 `REGRESSION: submitting an answer does NOT reset the timer`（计时持续增长 `0:00 → 0:04`）。真实观测依据见 `references/observations.md` 第 2、3、4 节。 |
| 3 | 无法可靠识别时提供可见提示或可用的手动恢复方式 | ✅ | 检测器发出 `uncertain` 后：面板显示黄色警告（`无法可靠识别题目变化（question region not found）。计时保持不变，可用"重置本题"手动开始。`）、「识别」一栏显示 `未识别/弱信号`、页脚显示 `识别不确定`，并保留「重置本题」「暂停」按钮。截图 `references/screenshots/overlay-degraded-unrecognised.png`。单元测试 `degrades conservatively when no question region is found`、`keeps the current timer when the identity disappears mid-question`。 |
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
| 10 | 页面刷新、标签页切换、浏览器休眠后恢复 | ⚠️ | 刷新由单元测试覆盖（会话恢复 + 配置持久化）；休眠由「大跨度时钟跳跃」单元测试覆盖。**真实休眠未实测**（见已知限制第 7 条）。 |
| 11 | 本地存储为空、已有记录或写入失败 | ✅ | `tests/storage.test.ts` 全覆盖：空存储、有记录、`failOnSet` / `failOnGet` / `failOnRemove`、无 `chrome` API、数据损坏清洗 |
| 12 | 页面结构变化导致无法找到题目区域时的降级处理 | ✅ | 单元测试 `goes uncertain, and keeps timing, when the region disappears`；截图 `overlay-degraded-unrecognised.png` |

**12 个场景中 10 个完全覆盖，2 个（#3、#10）部分覆盖并已如实记录。**

---

## 第 10 节 交付物清单

| # | 要求 | 状态 | 位置 |
|---|---|---|---|
| 1 | 完整 TypeScript 源代码 | ✅ | `src/`（10 个文件）；`pnpm run typecheck` 在 `strict` + `noUncheckedIndexedAccess` 下通过 |
| 2 | 可由 Edge 加载的构建输出目录 `dist/` | ✅ | `dist/`（332 KB）；`pnpm run build` 生成；`verify-dist.mjs` 56 项检查通过；已被真实 Edge 加载 |
| 3 | `manifest.json` 与最小必要图标资源 | ✅ | `public/manifest.json` → `dist/manifest.json`；图标 16/32/48/128 px，由 `scripts/make-icons.mjs` 用 Node 内置模块生成（无图像依赖），`verify-dist.mjs` 校验为真实 PNG 且尺寸匹配 |
| 4 | `README.md`：环境准备、构建、安装、升级、卸载与常见问题 | ✅ | `README.md`，含全部六项 + 故障排查 |
| 5 | 配置说明：模式、默认限时、提示音、本地数据位置/清除方式 | ✅ | `README.md` → 设置说明 / 本地数据与清除 |
| 6 | 单元测试及其运行说明 | ✅ | `tests/`（3 文件 103 用例）；运行说明见 `README.md` → 测试与验证 |
| 7 | 已验证页面类型清单和人工测试结果 | ✅ | `docs/compatibility.md`；研究依据 `references/page-inventory.md` |
| 8 | 已知限制清单 | ✅ | `docs/known-limitations.md`（14 条，含未满足的验收项） |

---

## 与需求文档「审核清单」（第 13 节）的一致性

| 审核项 | 实现情况 |
|---|---|
| 首版只支持 Microsoft Edge 桌面版 | ✅ 只验证 Edge 154；`minimum_chrome_version: 114` |
| TypeScript + Manifest V3，编译为可加载 JavaScript | ✅ `typescript` + `esbuild`（不压缩 + source map），`src/` 与 `dist/` 严格分离 |
| 倒计时结束只提醒，不自动提交或跳题 | ✅ `expired` 标记 + 一次提示音；无提交/导航代码路径；端到端已验证 |
| 本地保存数据，不使用云同步或账号系统 | ✅ 仅 `chrome.storage.local`；`verify-dist.mjs` 断言无任何网络 API |
| 仅对测试过的页面类型承诺支持 | ✅ `docs/compatibility.md` 分级；`references/page-inventory.md` 明确不承诺未验证页面 |
| 识别不确定时保守降级，不冒险重置计时 | ✅ `uncertain` 事件 → 保持计时 + 可见警告 + 手动重置；单元测试与截图佐证 |
| 首版包含本地计时记录清除功能与测试清单 | ✅ 弹出面板「清除全部记录」（端到端验证）+ 本对照表与测试清单 |

---

## 「建议默认决定」的落地（第 12 节）

| 建议 | 实现 |
|---|---|
| 标签页隐藏或电脑休眠：按真实经过时间计算，除非手动暂停 | ✅ 时间戳差分；`document.visibilityState === 'hidden'` 时写检查点但**不停表** |
| 倒计时到零：显示超时提醒，不自动提交或切题 | ✅ 见 8.2 #5 |
| 识别不确定：不自动重置；提示用户手动处理 | ✅ 见 8.3 #3 |
| 本地存储：不上传，提供清除功能 | ✅ 见 8.4 #1、#3、#4 |
| 兼容性声明：只对通过测试清单的页面类型做「已验证支持」声明 | ✅ 见 8.3 #4 |

---

## 参考：需求的「建议安装的 npm 包」落实情况

| 包 | 建议 | 实际 | 说明 |
|---|---|---|---|
| `typescript` | 必需 | ✅ 5.9.3 | `pnpm run typecheck` |
| `esbuild` | 必需 | ✅ 0.24.2 | `scripts/build.mjs` |
| `@types/chrome` | 推荐 | ✅ 0.0.287 | 扩展 API 类型 |
| `vitest` | 推荐 | ✅ 2.1.9 | 103 个用例 |
| `jsdom` | 推荐 | ✅ 25.0.1 | DOM 适配器测试环境（`vitest.config.ts`） |

**未引入** React、Vue、任何 UI 组件库、数据库驱动或网络请求库 —— 与需求文档
「我建议首版采用以下配置」一致。额外只加了 `@types/node`（构建脚本用）
与 `@rollup/wasm-node`（见 `README.md` → 故障排查）。

# Khan Academy Timer — 页面结构采集报告

- **采集日期：** 2025-10-09
- **采集者：** 实现者（自动化采集，无人工登录操作）
- **目标浏览器：** Microsoft Edge 154.0.4258.62（Chromium，macOS arm64）
- **采集工具：** Node.js v24.21.0 + Chrome DevTools Protocol（WebSocket）、Edge `--headless`、lxml
- **采集范围：** 仅限可计时所需的局部 DOM 结构与交互行为，未下载整站内容

---

## 1. 采集方法

### 1.1 为什么不能只用 `curl`

`curl https://www.khanacademy.org/...` 返回的是 **bot 挑战页**（`<title>Client Challenge</title>`，
约 3 KB），不是真实内容：

```
$ curl -s -o ka.html -w "%{http_code} %{size_download}\n" \
    https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction
200 3038
$ grep -o '<title>[^<]*</title>' ka.html
<title>Client Challenge</title>
```

**结论：** 纯 HTTP 抓取不可用。必须使用真实浏览器执行页面 JavaScript。

### 1.2 实际采用的采集路径

三条路径，按可信度从高到低：

| 路径 | 工具 | 得到什么 | 可信度 |
|---|---|---|---|
| A. 真实 Edge 静态快照 | `--headless --dump-dom` | 完整渲染后的真实 DOM | `Observed` |
| B. 真实 Edge 交互驱动 | CDP `Runtime.evaluate` | 答题/切题 **过程中** 的 DOM 与状态变化 | `Automated-tested` |
| C. 加载扩展后驱动 | CDP + `--load-extension` | 扩展在真实页面上的实际行为 | `Edge-verified` |

### 1.3 使 Edge 能在受限沙箱中运行的关键参数

在本机（DSH 文件沙箱）中直接运行 Edge 会崩溃：

```
sandbox initialization failed: Operation not permitted
Failed to initialize sandbox.
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:436] GPU process isn't usable. Goodbye.
→ Trace/BPT trap: 5
```

原因是 Chromium 自身的沙箱无法在 DSH 沙箱内初始化，且 Crashpad 无法写入
`~/Library/Application Support/Microsoft Edge/Crashpad/`。

**可用参数组合**（已固化在 `references/tools/capture-dom.sh`）：

```
--headless=old|new --no-sandbox --disable-gpu --disable-dev-shm-usage \
--disable-crash-reporter --disable-breakpad --crash-dumps-dir=<tmp> \
--no-first-run --no-default-browser-check --no-service-autorun \
--user-data-dir=<tmp> --virtual-time-budget=<ms>
```

两个额外要点：

1. `--dump-dom` **本身不会退出**（页面有长连接）。必须外部加超时并 `kill`，否则永远挂住。
2. `--virtual-time-budget` 必须给，否则同样不退出。

### 1.4 采集脚本

保留在 `references/tools/`，可复现：

| 文件 | 用途 |
|---|---|
| `capture-dom.sh` | 用真实 Edge 抓取渲染后的 DOM / 截图 |
| cdp-probe.mjs 系列（见 `research-notes.md` 记录的命令） | 通过 CDP 驱动真实交互并对比前后 DOM |
| `sanitize-snapshots.py` | 从原始抓取中提取**脱敏**的局部 DOM 样本 |

---

## 2. 采集的页面

| # | 页面 | URL 路径 | 类型 | 结果 |
|---|---|---|---|---|
| 1 | 三年级数学 单元页 | `/math/cc-third-grade-math/imp-addition-and-subtraction` | 课程/单元落地页 | ✅ 真实 DOM（55 个 testid），非练习页 |
| 2 | 加法练习 `addition_4` | `/math/.../imp-adding-with-regrouping-within-1000/e/addition_4` | **练习（4 题）** | ✅ 深度采集 + 4 次真实切题 |
| 3 | 四舍五入练习 | `/math/.../imp-rounding/e/rounding-to-the-nearest-ten-or-hundred` | 练习 | ✅ 首屏 DOM 已抓取 |
| 4 | 拆解加法练习 | `/math/.../imp-strategies-.../e/break-apart-three-dig-add` | 练习 | ⚠️ 仅排入队列，未完成分析 |
| 5 | 四舍五入 Quiz 1 | `/math/.../imp-rounding/quiz/imp-addition-and-subtraction-quiz-1` | **测验（quiz）** | ✅ 首屏 DOM + 截图 |
| 6 | 单元测试 | `/math/.../test/imp-addition-and-subtraction-unit-test` | 单元测试 | ⚠️ 仅排入队列，未完成分析 |
| 7 | 练习索引 | `/exercises` | 索引页 | ⚠️ 未分析（对计时无意义） |

> 只对 2、3、5 做了结构分析。其余页面的选择器**未被独立验证**，见
> `page-inventory.md` 的分级说明。

---

## 3. 关键采集结果（摘要）

完整证据见 `observations.md`、`research-notes.md` 与 `snapshots/`。

### 3.1 题目区域

练习页的真实结构（已脱敏，`snapshots/exercise-initial-question-region.html`）：

```
form[name="answerform"]                       ← 题目区域（稳定）
  div.perseus-renderer.perseus-renderer-responsive
    div.paragraph[data-perseus-paragraph-index="0"]   "Add."
    div.paragraph[data-perseus-paragraph-index="1"]   MathJax 竖式  608 / +251
    div.paragraph[data-perseus-paragraph-index="2"]
      div.perseus-widget-container.widget-inline-block
        input[data-testid="input-with-examples"].perseus-input
```

### 3.2 题号进度（**最重要的发现**）

练习页底部有一个「答题进度点」，每个点带一个 testid：

```
exercise-progress-<索引>-<状态>[-current]
```

真实观测到的完整序列（`addition_4`，共 4 题）：

| 状态 | testid |
|---|---|
| 当前题、未作答 | `exercise-progress-0-incomplete-current` |
| 第 1 题答对后 | `exercise-progress-0-correct-current` |
| 第 2 题尚未作答 | `exercise-progress-1-incomplete-current` |

以及答错时观测到的 `exercise-progress-0-incorrect-current`。

**这直接决定了识别方案：**

- 索引（`0`、`1` …）在**切题时**变化；
- 状态（`incomplete` / `correct` / `incorrect`）在**提交答案时**变化。

因此题目身份只能取**索引**。若把整个 testid 当作题目标识，学生每提交一次答案就会被
判定为「换了新题」，计时被错误重置 —— 这正是需求 2.4 / 8.3 明确禁止的行为。

### 3.3 答题反馈不在题目区域内

答对/答错的反馈是一个 `role="dialog"` 浮层，它是题目区域的**兄弟节点**，不是子节点：

```
body
  div > div._l9b1e3j > div[role="dialog"]      ← 反馈浮层（"Not quite yet..."）
  ...（题目区域在同一层级的另一分支）
```

实测对比（真实 DOM）：提交答案前后，`form[name="answerform"]` 的文本**完全一致**：

```
提交前: "Add.608+251―"
提交后: "Add.608+251―"    ← 逐字节相同
```

### 3.4 提示/解答会进入题目区域内部（风险点）

确认在 `#1` 题上点击 Skip 的「Yes, skip」后，提示内容全部展开，且**渲染在
`form[name="answerform"]` 内部**，该区域文本量从 `3,466` 字符暴涨到 `22,910` 字符：

```
q0  regionHtmlLength = 3466   text = "Add.608+251―"
q1  regionHtmlLength = 22910  text = "Add.608+251― Hint #1 1/4 608 8+1=9 +251 9 Hint #2 ..."
```

而同期 `exercise-progress-0-...-current` 的索引**没有变化**。

**结论：** 以索引为身份时，提示展开天然不会造成误判；若以区域文本为身份，则每次
展开提示都会误判切题。该场景已固化为回归测试
（`tests/question-detector.test.ts` → `REGRESSION — auxiliary content must not reset the timer`）。

### 3.5 真实切题行为（4 题完整验证）

通过 CDP 在真实页面上解出算式、提交、点击页面自带的「Next question」，连续完成 3 次切题：

| 阶段 | 进度索引 | 当前 testid | 题目区域文本 |
|---|---|---|---|
| 初始 | 0 | `exercise-progress-0-incomplete-current` | `Add.608+251` |
| 答对后 | 0 | `exercise-progress-0-**correct**-current` | `Add.608+251`（不变） |
| 切题后 | **1** | `exercise-progress-1-incomplete-current` | `Add.832+95`（变化） |
| 答对后 | 1 | `exercise-progress-1-correct-current` | `Add.832+95`（不变） |
| 切题后 | **2** | `exercise-progress-2-incomplete-current` | `Add.=621+111`（变化） |
| 答对后 | 2 | `exercise-progress-2-correct-current` | `Add.=621+111`（不变） |
| 切题后 | **3** | `exercise-progress-3-incomplete-current` | `Add.194+711`（变化） |

另外观测到按钮生命周期是确定性的：

```
未作答:  [exercise-check-answer] 存在,  [exercise-next-question] 不存在
答对后:  [exercise-check-answer] 消失,  [exercise-next-question] 出现
切题后:  [exercise-check-answer] 回来,  [exercise-next-question] 消失
```

### 3.6 不存在的信号

以下属性在练习页上**确认不存在**（各 0 次匹配）：

```
data-question-id  data-item-id  data-problem-id  data-perseus-id  data-question
```

存在的是 `data-exercise-id="2002"`（**整个练习**的 id，不是单题 id）。

**结论：** Khan Academy 不为单题提供稳定 id，因此必须使用「进度索引 + 题干指纹」，
不能像需求 2.4 的优先方案那样直接取站点题目 ID。

---

## 4. 访问限制（必须如实记录）

1. **纯 HTTP 抓取不可用** —— 存在 bot 挑战页，必须真实浏览器。
2. **未登录状态采集** —— 本次全部在未登录状态下完成。登录后专属内容
   （课程进度、已完成的练习、教师指派作业）**未观测**。
3. **只覆盖英文站** —— 仅访问了 `www.khanacademy.org`；`es.` / `pt.` 等本地化站点
   未验证（但界面文案不影响选择器，因为方案不依赖文案）。
4. **题型覆盖有限** —— 深度验证的只有**数值输入题**（`perseus-input`）。
   选择题、表达式输入、下拉题、拖拽题、交互图（interactive-graph）**未实际观测**，
   仅在 `ANSWER_WIDGET_MARKERS` 中预留了通用标记。
5. **未观测 Hint 面板的独立入口** —— 页面上有 "Hints" 文案，但按文案查找 Hint 控件
   未命中；提示内容只通过 Skip 确认框间接触发观测到。因此**未确定提示容器的稳定选择器**，
   代码中也没有臆造该选择器（见 `src/site-profile.ts` 的 `HINT_SUBTREES` 说明）。
6. **未验证测验（quiz）与单元测试的切题行为** —— 只抓取了 quiz 首屏 DOM。
   quiz 的进度标记结构与练习一致（同一套 `exercise-progress-*`），但**切题流程未驱动验证**。
7. **课程/单元落地页与 A/B 测试变体未覆盖** —— 需求 4 要求不承诺未验证页面。

---

## 5. 采集结果的可信度分级

严格按需求文档的四个等级标注，**不把「公开页面可访问」「模拟 DOM 测试通过」或
「代码编译成功」等同于真实练习页兼容**：

| 等级 | 含义 | 本项目的具体对象 |
|---|---|---|
| `Edge-verified` | 已在真实 Edge 页面驱动验证行为 | 练习页 `addition_4` 的：面板注入、正计时自动开始、暂停/继续/重置、**答对/跳过即停表**、**提示展开不重置计时**、切题结算并保存记录、**结束页显示每题用时** |
| `Automated-tested` | 已用自动化驱动真实页面并对比前后状态 | 练习页 `addition_4` 的：进度索引 0→1→2→3、题库切换、反馈浮层位置、提示展开后的区域文本变化 |
| `Observed` | 已观察到页面结构，未驱动验证行为 | 练习页 `rounding-to-the-nearest-ten-or-hundred`、quiz `imp-addition-and-subtraction-quiz-1` 的静态 DOM |
| `Unverified` | 尚未实际验证 | 单元测试页、选择题/表达式/交互图等题型、登录后页面、本地化站点、其他课程 |

---

## 6. 数据处理与脱敏

原始抓取（约 565 KB/页）含有与本项目无关的数据，**不保留**：

- `__KA_DATA__` 内联应用状态整块
- **543 处 `kaid`**（Khan Academy 的实验分桶哈希）
- 其他 `*_id` / 用户名 / 邮箱形态字段（扫描确认邮箱与 token 均为 0）

`references/tools/sanitize-snapshots.py` 只提取三块局部结构
（题目区域 / 页脚 / 反馈浮层），并：

- 删除全部 `script` / `style` / `noscript` / `iframe`
- 白名单保留属性（仅 `class` / `name` / `role` / `data-testid` / `aria-*` 等）
- 正则脱敏 64 位与 32 位十六进制哈希、邮箱

脱敏后产物**已逐文件复扫确认 CLEAN**（`snapshots/*.html`，共 8 个文件，
每个 0.9–5.7 KB）。原始抓取文件在采集结束后删除。

本项目**不采集**：答案内容、账号凭证、个人资料、与计时无关的数据。

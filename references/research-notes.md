# 采集原始记录与研究笔记

本文件记录采集过程的**可复现细节**：运行了哪些命令、得到了什么、`src/site-profile.ts`
里每个选择器的来源，以及未能确定的部分。

配套文件：

- `collection-report.md` —— 方法、页面、访问限制
- `observations.md` —— 交互行为观察（切题 / 反馈 / 提示 / 输入 / 跳过）
- `page-inventory.md` —— 页面类型与验证分级
- `snapshots/` —— 脱敏后的局部 DOM 与 testid 清单
- `screenshots/` —— 关键状态截图
- `tools/` —— 可复现的采集与脱敏脚本

---

## 1. 环境

```
macOS (arm64)
Node.js         v24.21.0
Microsoft Edge  154.0.4258.62   /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
Python          3.12（lxml 6.1.3）
```

未安装 Playwright，也未安装任何浏览器自动化框架。**采集完全使用 Node 内置的
`fetch` 与全局 `WebSocket`（Node ≥ 22 自带）直接讲 Chrome DevTools Protocol**，
因此没有为采集引入任何依赖。

---

## 2. 逐步过程与命令

### 2.1 确认纯 HTTP 不可用

```bash
curl -s -o /tmp/ka.html -w "HTTP:%{http_code} SIZE:%{size_download}\n" \
  https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction
# → HTTP:200 SIZE:3038
grep -o '<title>[^<]*</title>' /tmp/ka.html
# → <title>Client Challenge</title>
```

`/tmp/ka.html` 内容是 bot 挑战壳：CSP 头、`/_fs-ch-*/script.js` 加载器、
`<noscript>` 提示。**不是真实页面。** 这一步排除了纯 HTTP 抓取路线。

### 2.2 让真实 Edge 在受限沙箱中跑起来

第一次尝试直接崩溃：

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --headless=new --disable-gpu --user-data-dir=... --dump-dom <url>
# → Trace/BPT trap: 5
```

stderr 关键行：

```
sandbox initialization failed: Operation not permitted
Failed to initialize sandbox.
ERROR:third_party/crashpad/.../file_io_posix.cc:208] open
  ~/Library/Application Support/Microsoft Edge/Crashpad/throttle_store.dat: Operation not permitted (1)
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:436] GPU process isn't usable. Goodbye.
```

**修正后的可用参数**（已写入 `tools/capture-dom.sh`）：

```
--headless=old|new
--no-sandbox                        # 必需：Chromium 沙箱无法在 DSH 沙箱内初始化
--disable-gpu --disable-dev-shm-usage
--disable-crash-reporter --disable-breakpad --crash-dumps-dir=<tmp>   # Crashpad 无法写 HOME
--no-first-run --no-default-browser-check --no-service-autorun
--user-data-dir=<每次全新的临时目录>   # 避免 ProcessSingleton 冲突
--virtual-time-budget=<ms>          # 必需，否则 --dump-dom 永不退出
```

另外记录两个坑：

- `macOS 没有 timeout(1)`（那是 GNU coreutils 的 `gtimeout`）。脚本改为「后台启动 +
  `sleep` 到点 `kill -9`」的看门狗，`--dump-dom` 因此才能可靠收敛。
- `--headless=old` 与 `--headless=new` 在本机都能产出同样的 DOM；脚本默认 `old`。

### 2.3 一次典型的静态抓取

```bash
references/tools/capture-dom.sh dom exercise-addition_4 \
  "https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4" \
  old 25000
# → dom exercise-addition_4 mode=old exit=137 bytes=566066
```

`exit=137` 是看门狗发出的 `SIGKILL`，属预期；DOM 已完整写出（566 KB）。

### 2.4 找到练习页的真实入口

课程/单元落地页的 DOM 里含真实练习链接，从中提取：

```bash
grep -oE 'href="/[^"]*/(e|quiz|test)/[^"]*"' page.html | sort -u
```

得到 16 个 `/e/` 练习、5 个 `/quiz/`、1 个 `/test/` 的真实 URL。**没有猜测 URL。**

### 2.5 驱动真实交互（关键一步）

静态 DOM 只能看到首屏。为了观察「答题 → 反馈 → 切题」，写了一个基于 CDP 的驱动器：

```bash
node references/tools/cdp-probe.mjs <exerciseUrl> <outDir>
```

它做的事情：

1. 启动带 `--remote-debugging-port` 的 Edge；
2. 从 `http://127.0.0.1:<port>/json/list` 拿到 page target 的 `webSocketDebuggerUrl`；
3. 用 Node 全局 `WebSocket` 连接，发 `Runtime.evaluate`；
4. 从题干正则解出 `a+b` → 算出正确答案；
5. 用**原生 value setter + `input`/`change` 事件**写入输入框（React 受控组件必须这样写）；
6. 点击 `[data-testid="exercise-check-answer"]`；
7. 等页面把 `exercise-check-answer` 换成 `exercise-next-question` 后点击它；
8. 每个阶段都 `Runtime.evaluate('document.documentElement.outerHTML')` 存盘并提取信号。

**结果：连续 3 次真实切题全部成功**（详见 `observations.md` 第 1 节）。

### 2.6 加载扩展后的端到端验证

```bash
node scripts/verify-extension.mjs
# → all 32 extension checks passed
```

这条命令是本项目**最强的验证手段**：它把 `dist/` 作为解压扩展加载进真实 Edge，
在真实练习页上驱动，并直接从面板的 Shadow DOM 里读数值。

---

## 3. 选择器来源（逐条）

`src/site-profile.ts` 中每条都带 `[OBS]` / `[VER]` / `[STD]` 标注。逐条说明：

| 选择器 | 来源 | 证据 |
|---|---|---|
| `form[name="answerform"]` | `[OBS][VER]` | 提交答案前后 textContent 逐字节相同；真实切题时内容随之变化 |
| `.framework-perseus` | `[OBS]` | 真实 DOM 中存在；文本 `"ProblemAdd.608+251"` |
| `.perseus-renderer` | `[OBS]` | 真实 DOM；问答前后文本 `"Add.608+251―"` 不变 |
| `[data-perseus-paragraph-index]` | `[OBS]` | 题干三段分别带 `0` / `1` / `2` |
| `.perseus-widget-container` | `[OBS]` | 真实 DOM：`div.perseus-widget-container.widget-inline-block` |
| `.perseus-input` | `[OBS]` | 输入框 class 含 `perseus-input` |
| `[data-testid="input-with-examples"]` | `[OBS]` | 真实输入控件 |
| `[data-testid^="exercise-progress-"]` | `[OBS][VER]` | 4 个进度点；索引随切题 0→1→2→3 |
| `[data-testid="content-library-footer"]` | `[OBS]` | 页脚容器，含进度点与按钮 |
| `[data-testid="exercise-check-answer"]` | `[OBS][VER]` | 提交按钮；答对后消失 |
| `[data-testid="exercise-next-question"]` | `[OBS][VER]` | 答对后出现，点击切题成功 |
| `[data-testid="exercise-skip-button"]` | `[OBS][VER]` | 点击弹确认框 |
| `[data-testid="start-over-button"]` | `[OBS]` | `aria-label="Start over"` |
| `[data-exercise-id]` | `[OBS]` | `data-exercise-id="2002"` |
| `[role="dialog"]` | `[OBS]` | 反馈浮层 / Skip 确认框 / Cookie 横幅 |
| `[role="alert"]`、`[aria-live]` | `[STD]` | 仅作防御性冗余，非站点特有 |

### 明确**没有**使用的东西

- **哈希类名**：真实 DOM 里出现 `_1yfus1e`、`_7zhre1`、`_xa8e8o1`、`_5a3p999`、
  `perseus_QUlWSKE-`、`_128erqiNaN` 等。这些是 Emotion / styled-components /
  CSS Modules 生成的，每次站点构建都会变，**一律不用**。
- **`[data-testid="content-panel-wrapper"]` 作题目区域**：实测它在提交答案后会把
  「Related content」侧栏内容纳入自己，文本不再是常量。已排除。
- **完整 `exercise-progress-<i>-<state>` 作题目标识**：实测状态段在提交答案时
  `incomplete → correct`，会导致每次提交都误判切题。**只用索引**。
- **`role="dialog"` 当「反馈」的同义词**：它同时用于 Cookie 横幅和 Skip 确认框。

---

## 4. 确认不存在的信号

```python
for name in ['data-question-id','data-item-id','data-exercise-id','data-problem-id',
             'data-perseus-id','data-question','data-key','data-content-id']:
    print(name, len(doc.xpath(f'//*[@{name}]')))
```

```
data-question-id  0
data-item-id      0
data-exercise-id  1     ← 值为 "2002"，是整个练习的 id
data-problem-id   0
data-perseus-id   0
data-question     0
data-key          0
data-content-id   0
```

`form[name="answerform"]` 自身的属性只有 `class` 与 `name`；
其内部出现过的 data-* 属性只有 `data-perseus-paragraph-index`。

**结论：** 站点不提供单题稳定 id。需求 2.4 的优先方案（用稳定题目 ID）在本站点
不可行，退化为「进度索引 + 题干指纹 + 题型签名」。

---

## 5. 一次关键的成功对照：提示展开

Skip → "Yes, skip" 后，同一题（索引 0）的进度 testid 与区域文本：

```
前: progressIndex=0  currentTestId=exercise-progress-0-incomplete-current
    form[name=answerform] 文本长度 3466

后: progressIndex=0  currentTestId=exercise-progress-0-incorrect-current
    form[name=answerform] 文本长度 22910
    内容: "Add.608+251― Hint #1 1/4 608 8+1=9 +251 9 Hint #2 2/4 ... Hint #4 4/4 ..."
```

**索引不变、文本暴涨** —— 这直接证明了「索引作身份」的必要性，并已写成回归测试。

---

## 6. 未确定 / 未观察（Open questions）

1. **提示容器的稳定选择器**：页面上有 "Hints" 文案，但按文案查找控件未命中；
   提示内容只通过 Skip 确认框间接触发。`HINT_SUBTREES` 因此留空，且不臆造选择器。
2. **选择题 / 表达式 / 拖拽 / 交互图 的 DOM**：完全未观测。
3. **Quiz 与 Unit test 的切题流程**：只抓了 quiz 首屏；切题是否与练习一致未驱动验证。
4. **`correct` 之前的其他状态字**：只观测到 `incomplete`、`correct`、`incorrect`
   三种。是否存在 `skipped` 等其他值未知（代码只做包含匹配，因此不影响正确性）。
5. **登录态页面**：未观测，且不索取凭证。
6. **本地化站点**：未访问。
7. **连续 10 次切题**：自动化只完成 3 次（4 题的练习上限为 4 次）。
8. **真实休眠 / 长时间后台**：未做实测，仅单元测试覆盖时间戳语义。
9. **`Start over` 的语义**：未驱动验证；代码按「同索引生成新题」处理并已加单元测试。

---

## 7. `references/` 目录结构

```
references/
├── collection-report.md          # 采集方法与访问限制
├── observations.md               # 交互行为观察
├── page-inventory.md             # 页面类型与验证分级
├── research-notes.md             # 本文件
├── screenshots/
│   ├── overlay-countup.png                 # 面板在真实练习页上正计时
│   ├── overlay-countdown-expired.png       # 倒计时归零的超时状态（面板变红）
│   ├── overlay-collapsed.png               # 折叠为小胶囊
│   ├── overlay-degraded-unrecognised.png   # 识别不确定时的保守降级与可见提示
│   └── popup-settings.png                  # 扩展弹出面板
├── snapshots/
│   ├── exercise-initial-question-region.html
│   ├── exercise-initial-exercise-footer.html
│   ├── exercise-after-wrong-answer-question-region.html
│   ├── exercise-after-wrong-answer-exercise-footer.html
│   ├── exercise-after-wrong-answer-feedback-dialog.html
│   ├── exercise-after-correct-answer-question-region.html
│   ├── exercise-after-correct-answer-exercise-footer.html
│   ├── exercise-after-correct-answer-feedback-dialog.html
│   └── exercise-page-testids.md
└── tools/
    ├── capture-dom.sh                # 真实 Edge 抓 DOM / 截图
    ├── cdp-probe.mjs                 # 通过 CDP 驱动真实交互并对比前后 DOM
    ├── cdp-extension-diagnostics.mjs # 加载扩展后读出检测器诊断（排查「面板卡住」）
    ├── sanitize-snapshots.py         # 从原始抓取提取脱敏局部样本
    └── capture-with-extension.mjs    # 加载扩展后截图
```

> `capture-dom.sh` 需要显式指定输出路径；用法：
>
> ```bash
> ./tools/capture-dom.sh dom <名称> <URL> [old|new] [虚拟时间预算ms]
> ./tools/capture-dom.sh shot <名称> <URL> [old|new] [虚拟时间预算ms]
> ```
>
> 产物写入 `references/.tmp-caps/`（该目录为临时目录，不随交付物保留）。

---

## 8. 脱敏核验

对 `snapshots/` 全部产物复扫，确认不含个人信息：

```python
patterns = [ 64位十六进制哈希 → "<redacted-hash>",
             32位十六进制 id  → "<redacted-id>",
             邮箱形态        → "<redacted-email>" ]
```

扫描结果：**8/8 文件 CLEAN**（`kaid`、`__KA_DATA__`、邮箱、token 均为 0）。

原始抓取文件（每页约 566 KB，含 543 处 `kaid` 与整块 `__KA_DATA__`）在采集结束后
**已删除**，不随交付物保留。

---

## 9. 研究阶段的结论（题目识别方案）

综合以上观察，最终方案是：

1. **题目区域** = `form[name="answerform"]`（→ `.framework-perseus` → `.perseus-renderer` 依次降级）。
   选择依据：它在答题、显示反馈、展开提示时文本均保持稳定（提示内容虽进入其内部，
   但不参与身份判定）。
2. **题目标识** = 进度索引（`exercise-progress-<i>-...-current` 中的 `<i>`），
   生成 `progress:<i+1> of <total>`。这是站点提供的、与语言无关的位置信号。
3. **降级路径**：无进度标记时，用 `题干文本 + 题型签名` 的哈希作为指纹，
   置信度降为 `fingerprint`，面板显示较低置信度。
4. **保守降级**：找不到题目区域或无可用身份时，发出 `uncertain`，
   **保持当前计时不变**，面板给出可见警告并保留手动重置/暂停。
5. **去抖 + 抑制重复**：新身份需连续稳定 `debounceMs`（默认 400 ms）且距上次切换
   ≥ `cooldownMs`（默认 1200 ms）才提交；出现候选时主动安排一次延后复核。
6. **显式重置信号**：URL 变化（`decider.reset`）与「Start over」点击（`decider.reseed`）
   作为可靠信号立即生效，覆盖「同索引换题」这类索引无法区分的场景。
7. **选择器集中管理**：全部站点适配规则位于 `src/site-profile.ts` 单文件，
   每条标注来源，便于站点改版后集中维护。

**未覆盖页面不会被标为「已验证支持」**，见 `page-inventory.md`。

# 交互行为观察记录

> **时效声明：** 以下行为是 2025-10-09 在真实页面上实测到的，不是对静态 DOM 的推断。
> 可汗学院改版后结论可能失效；引用前请先在当前站点上复核（方法见
> [`AGENTS.md`](../../AGENTS.md)）。这些结论的价值在于「为什么」，而不是「今天仍然如此」。

本文件记录**实际驱动真实页面**观察到的行为，而不是静态 DOM 的推断。
每条都标注了观察方式与可信度等级（定义见 `collection-report.md` 第 5 节）。

观察对象：练习页
`/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4`
（4 题的数值输入练习），Microsoft Edge 154，未登录。

---

## 1. 切题（question advance）

**方式：** CDP 驱动。从题干中正则解出 `a+b` 算式，写入输入框（用原生 value setter +
`input`/`change` 事件，以便 React 感知），点击页面自带的 Check，待判定为正确后点击
页面自带的 `[data-testid="exercise-next-question"]`。

**等级：** `Automated-tested`（真实页面、真实交互），并已在扩展加载后复现（`Edge-verified`）。

### 观察结果

| 阶段 | 进度索引 | 当前进度 testid | 题目区域文本 | Check 按钮 | Next 按钮 |
|---|---|---|---|---|---|
| 初始 | 0 | `exercise-progress-0-incomplete-current` | `Add.608+251` | 存在 | 无 |
| 答对后 | 0 | `exercise-progress-0-correct-current` | `Add.608+251`（**不变**） | 消失 | 出现 |
| 切题后 | **1** | `exercise-progress-1-incomplete-current` | `Add.832+95`（**变化**） | 出现 | 消失 |
| 答对后 | 1 | `exercise-progress-1-correct-current` | `Add.832+95`（不变） | 消失 | 出现 |
| 切题后 | **2** | `exercise-progress-2-incomplete-current` | `Add.=621+111`（变化） | 出现 | 消失 |
| 答对后 | 2 | `exercise-progress-2-correct-current` | `Add.=621+111`（不变） | 消失 | 出现 |
| 切题后 | **3** | `exercise-progress-3-incomplete-current` | `Add.194+711`（变化） | 出现 | 消失 |

连续 3 次切题全部成功，`perseus-renderer` 数量始终为 1。

### 由此得出的识别规则

**题目身份 = 进度索引**。理由：

- 索引在切题时变化 → 能检测切题；
- 索引在提交答案时**不变** → 提交答案不会误判为切题；
- 索引在展开提示时**不变** → 展开提示不会误判为切题（见第 3 节）。

### 切题时题目区域节点是否被替换？

用「给节点打标记属性」的方法验证：给 `form[name="answerform"]` 打上
`data-probe-tag`，切题后读取该属性。

- 在**未发生真正切题**的交互（提交答案、跳过确认框）中，标记一直存活 → 节点被复用，仅内容变化。
- 无论复用还是替换，检测器都以 `MutationObserver` + 定期轮询兜底，两种情形都能覆盖。

---

## 2. 答题反馈（feedback）

**方式：** 先故意填错（`1`）提交，再填对（`859`）提交，分别抓取完整 DOM 并做节点级 diff。

### 观察结果

**反馈是一个 `role="dialog"` 浮层，位于题目区域之外**（兄弟层级，不在
`form[name="answerform"]` / `.framework-perseus` / `.bibliotron-exercise` 之内）：

```
body
  div
    div._l9b1e3j
      div[role="dialog"]._7zhre1        ← 答错反馈
        button[data-testid="popover-close-btn"][aria-label="Close Popover"]
        h4."Not quite yet..."
        span."Give it another try!"
        button."Show a step"
```

答对时同一容器换成：

```
h4."There you go!"  /  span."Keep it up!"  /  button."See a step-by-step solution."
```

**已脱敏样本：** `snapshots/exercise-after-wrong-answer-feedback-dialog.html`

### 关键结论

提交答案前后，`form[name="answerform"]` 与 `.framework-perseus` 的 `textContent`
**逐字节相同**：

```
提交前: "Add.608+251―"
提交后: "Add.608+251―"
```

→ 反馈天然不会污染题目区域指纹。代码中另外把 `[role="dialog"]` / `[role="alert"]` /
`[aria-live]` 从指纹中剔除，作为防御性冗余。

### 注意：`role="dialog"` 并非只有反馈

同一个页面上还用 `role="dialog"` 承载：

- Cookie 同意横幅（多语言文案）
- 点击 Skip 后的确认框（"Are you sure? Skipped questions will count as incorrect."）
- 点错题目的解法弹窗

因此**不能**把 `role="dialog"` 当作「反馈」的同义词。判定答题对错时，本项目优先使用
**进度标记的状态段**（`...-incorrect-current` / `...-correct-current`），这是结构化且
与语言无关的信号。

---

## 3. 提示 / 解答（hints, solution）—— 最重要的风险点

**方式：** 点击 Skip → 弹出确认框 → 点击 "Yes, skip" → 抓取完整 DOM 前后对比。

### 观察结果

提示与分步解答**渲染在题目区域内部**（`form[name="answerform"]`），区域文本量暴涨：

| 阶段 | 进度索引 | `form[name="answerform"]` 文本长度 | 内容片段 |
|---|---|---|---|
| 提示展开前 | 0 | 3,466 字符 | `Add.608+251―` |
| 提示展开后 | **0（未变）** | **22,910 字符** | `Add.608+251― Hint #1 1/4 608 8+1=9 +251 9 Hint #2 2/4 … Hint #4` |

同时：

- 进度索引**没有变化**（仍是第 1 题）；
- `perseus-renderer` 数量仍是 1；
- 题干的算式**没有变化**。

### 为什么这条决定了整个识别方案

如果题目标识 = 题目区域的文本指纹，那么**学生每点开一次提示，计时就会被错误重置**。
这正是需求 2.4 与验收标准 8.3 明确禁止的行为：

> 输入答案、打开提示、显示答题反馈、展开辅助内容时，不应无条件重置题目计时。

**采用索引作为身份后，该场景天然不会误判**：索引没变 → 判定为同一题 → 计时继续。

该场景已固化为单元回归测试：

```
tests/question-detector.test.ts
  REGRESSION — auxiliary content must not reset the timer (spec 2.4, 8.3)
    > hint expansion that grows the region 3.5 KB -> 23 KB is NOT a question change
```

### 未观测的部分

页面上存在 "Hints" 文案，但按文案查找 Hint 展开控件**未命中**（可能需滚动或位于
其他容器内）。因此**没有确定提示容器的稳定选择器**，代码中也没有臆造
（见 `src/site-profile.ts` 的 `HINT_SUBTREES` 注释）。本方案不依赖该选择器。

---

## 4. 输入答案（typing）

**方式：** 通过原生 value setter 写入输入框并派发 `input` / `change` 事件。

### 观察结果

- 输入框：`input[data-testid="input-with-examples"].perseus-input`，
  `aria-label="Your answer:"`，`type="text"`。
- 输入内容只改变 `input.value`，题目区域文本、进度索引均不变。
- 输入本身**不产生任何提交**，不会触发反馈浮层。

→ 输入答案不会造成误判。

---

## 5. 跳过（skip）

**方式：** 点击 `[data-testid="exercise-skip-button"]`，观察前后状态。

### 观察结果

**第一次点击不会直接跳到下一题**，而是弹出确认框：

```
role="dialog"
  "Are you sure? Skipped questions will count as incorrect. You'll still be able to review the solution."
  buttons: [aria-label="Close modal"], "Yes, skip", "Cancel"
```

只有点击 "Yes, skip" 才生效；此时该题被标记为已跳过（进度状态变化）并展开提示。

**对实现的影响：** 不能用 Skip 作为「可靠切题信号」，也不应把 Skip 点击当作切题。
代码中 `SKIP_BUTTON` 仅用于识别控件，不改变计时状态。

---

## 6. 开始（Start over）

**方式：** 读取 DOM 观察控件。

`button[data-testid="start-over-button"][aria-label="Start over"]`

**未驱动验证**（`Unverified`）：点击后是否在同一进度索引上生成**新**题目没有实测。
若确实如此，由于题目身份是索引，索引不变则自动检测无法发现这次更换。

**因此实现中做了显式处理：** 监听 `start-over-button` 的点击，把该次操作当作
「题目被就地重新生成」，强制为新题并重新开始计时（`decider.reseed()`）。
该行为有单元测试覆盖：

```
tests/question-detector.test.ts
  > reseed restarts even when the identity is unchanged ("Start over")
```

---

## 7. 页面刷新与标签页切换

**方式：** 代码路径审查 + 单元测试（未在真实页面做休眠实测，标记 `Unverified`）。

### 时间语义（按需求 12 的建议默认值实现）

| 情形 | 行为 | 实现方式 |
|---|---|---|
| 标签页隐藏 / 电脑休眠（页面仍打开） | 按**真实经过时间**计算 | 时间戳差分，不依赖定时器触发次数 |
| 手动暂停 | 停止累积 | 状态机 `paused` |
| **关闭页面后重新打开** | 冻结关闭期间的时钟，恢复已累计用时 | `session:<exerciseKey>` 检查点 + `TimerEngine.restore` |

第三行是相对需求 2.2「在做题时关闭页面，保留计时数据，在下次重新做本套题目时继续使用
之前的数据」的落地解释：关闭页面期间学生并未在作答，因此这段时间不计入。

会话只在**题目与练习都匹配**时恢复（`session.questionKey === 当前题目标识` 且
`session.exerciseKey === 当前练习`），超过 12 小时的会话会被丢弃。

单元测试覆盖：

```
tests/timer-engine.test.ts
  TimerEngine — persistence across a page reload (spec 2.2)
tests/storage.test.ts
  in-flight sessions (spec 2.2 — closing the page keeps the data)
```

---

## 8. 计时精度相关观察

- 页面上的题目进度点尺寸为 16×16 px，`display: flex`，可见；
- 页脚容器宽度约 1016 px、高约 66 px，位于题目区域之外；
- 上述数据由 CDP 在真实页面上测量，用于确认进度点确实可见（不是隐藏的移动端副本）。

另外确认：页面上**只有 1 个** `[data-testid="content-library-footer"]`，进度点
**只有 1 组 4 个**，且同一时刻**只有 1 个** 带 `-current` → 不存在「桌面/移动双份
DOM 导致读到过期索引」的问题（这一假设曾被排查并排除）。

---

## 9. 由真实页面验证发现并修复的实现缺陷

把扩展加载进真实 Edge 并驱动页面后，`scripts/verify-extension.mjs` 发现了两个静态
分析和单元测试都没有暴露的缺陷。记录在此，作为回归依据。

### 9.1 进度观察器绑定到已被替换的页脚节点

题目进度点位于题目区域**之外**的页脚中，因此检测器额外监听页脚容器。原实现在
「题目区域节点未变化」时**提前返回**，导致页脚被 SPA 替换后，观察器仍绑在已脱离
文档的旧节点上，切题再也无法被立即发现。

**修复：** 分离「题目区域」与「进度容器」的绑定逻辑，进度容器每次都会重新解析并重新绑定。

**回归测试：**

```
tests/question-detector.test.ts
  > confirms a pending change by itself, with no further DOM mutations
```

### 9.2 去抖候选永远得不到确认

去抖要求「同一个新身份持续 `debounceMs` 后**再观察一次**」才提交。揭示变化的那次 DOM
变更在去抖窗口结束时早已被消费完，之后页面不再变化 → 再没有任何评估 →
候选永远停在 `pending`，**切题始终不生效，旧题的计时一直跑下去**。

实测症状（从扩展暴露的诊断属性读出）：

```
lastEvent   : "检测到可能的题目变化，等待确认…"
evaluateCount: 7   （冻结）
sinceEvaluateMs: 5349 → 9349   （持续增长，说明再无评估）
```

**修复：** 出现 `pending` 候选时主动安排一次延后复核（`debounceMs` 之后）；
轮询也把「存在待确认候选」作为兜底触发条件。

**回归测试：**

```
tests/question-detector.test.ts
  > confirms a pending change by itself, with no further DOM mutations
  > does not keep re-evaluating once a candidate is resolved
```

这两条正是需求 5.3「题目识别模块只发出明确事件，由计时引擎决定是否切换计时」与
验收标准 8.2「切换题目时保存上一题记录，并启动新题计时」要求的行为。

---

## 10. 练习结束与 summary 页面（本轮新增采集）

**方式：** CDP 驱动，连续解出 4 道题并逐题前进，观察最后一题之后的控件变化，然后点击
页面给出的结束控件。练习为 `addition_4`（4 题、无 bonus question）。

### 10.1 最后一题的按钮：testid 不变，**文案会变，而且有三种**

`exercise-next-question` 这个 testid **始终是同一个「前进」控件**，但它的文案随阶段变化。
逐题实测 `addition_4` 得到的完整序列：

| 阶段 | 该控件的文案 | 点击后的结果 |
|---|---|---|
| 第 1 题答对后 | `Next question` | 进入第 2 题 |
| 第 2 题答对后 | `Next question` | 进入第 3 题 |
| 第 3 题答对后 | `Next question` | 进入第 4 题 |
| **第 4 题答对后** | **`Bonus question`** | **进入加试题，进度索引回到 0** |
| **加试题答对后** | **`Show summary`** | **进入结束页** |

**两个关键结论：**

1. **不能用 testid 判断「是否最后一题」** —— 三种情形共用一个 testid，只有文案不同。
   实现里不去区分，统一当作「前进」控件处理，由后续状态决定发生了什么
   （进度索引变化 → 换题；`answerform` 消失 → 结束页）。
2. **`addition_4` 是有 bonus question 的** —— 这是本次采集的一个修正：
   早期把「进度索引 3 → 0」误读为「练习被重做」，实际是**进入了加试题**。

### 10.1.1 加试题会让进度索引倒退

进入加试题后，进度标记重新从 0 开始：

```
第 4 题答对: currentTestId = exercise-progress-3-correct-current
点击 Bonus question 后: currentTestId = exercise-progress-0-incomplete-current
```

因此**进度索引不是单调递增的**，不能把「索引变小」当作「练习重新开始」。
据此修正了实现：取消「索引倒退即开新一轮」的规则（该规则会在加试题处错误地
把一轮练习拆成两轮），改为：

- 结束页出现时才结束本轮（`leaveSummary` 清空 run）；
- 「Try again」重做时，结束页消失 → 自然开始新一轮；
- 结束页表格**按捕获顺序编号**（第 1 题、第 2 题……），而不是用页面索引编号，
  这样加试题不会让表格出现两个「第 1 题」；
- 索引倒退的那一行标记为**「加试」**。

### 10.2 summary 页面的结构（已脱敏）

点击 `Show summary` 后，`form[name="answerform"]` **消失**，进度标记也全部消失，
但练习外壳仍在。真实结构：

```
div.bibliotron-exercise
  header
    h1[content-library-content-title]  «Add within 1000»
  div
    div
      div
        div.exercise-chrome-content-for-mobile-zoom
          div
            details … «Show»            ← 画板折叠区
            div[data-testid="eot-phantom-user-registration"]   ← ★ summary 卡片
              div
                h1  «Exercise complete!»
                span «4/4 correct»
              div
                h3  «Want to save your progress?»
                span «Create an account to be able to track your…»
          div[drawing-area]
```

### 10.3 summary 的判定：用结构，不用那个 testid

对全部 6 个采集阶段逐一验证如下不变式：

```
summary ⇔ (无 form[name="answerform"]) 且 (存在 .bibliotron-exercise)
```

| 阶段 | answerform | 进度标记 | `eot-phantom-user-registration` | bibliotron-exercise | 判定 |
|---|---|---|---|---|---|
| 初始 | 有 | 4 | 无 | 有 | 否 |
| 第 1 题答对 | 有 | 4 | 无 | 有 | 否 |
| 第 2 题答对 | 有 | 4 | 无 | 有 | 否 |
| 第 3 题答对 | 有 | 4 | 无 | 有 | 否 |
| 第 4 题答对 | 有 | 4 | 无 | 有 | 否 |
| **Show summary 之后** | **无** | **0** | **有** | 有 | **是** |

**为什么不用 `eot-phantom-user-registration` 作为判定依据：**
该 testid 的字面含义是「end-of-task **phantom user**（未登录用户）registration」，
即只在**未登录**时出现的注册引导卡片。登录用户看到的结束页面大概率没有这个 testid。
本次采集全程未登录，因此**无法验证登录态的结构**。

采用结构不变式后，登录态与非登录态都能判定为 summary；插入位置则按
「summary 卡片 → 练习外壳」的顺序降级，保证登录态也能插入（位置可能不同）。
`docs/known-limitations.md` 中已如实记录该未验证点。

### 10.4 插入位置

卡片插入到 summary 卡片内部、**评分行之后、注册引导之前**：

```
div[data-testid="eot-phantom-user-registration"]
  div            ← 评分行（Exercise complete! / 4/4 correct）
  ★ 本轮每题用时（扩展注入，Shadow DOM 隔离）
  div            ← Want to save your progress?
```

实现上使用「插入到宿主第一个元素之后」，而不是依赖 `_1j9xg4ga` 这类哈希类名；
若该卡片不存在（例如登录态），则降级为追加到 `.bibliotron-exercise` 末尾。

### 10.5 summary 上的其它观测

- 页脚出现一个 **`Try again`** 按钮（无 testid，靠文案/a11y 匹配），点击即重新开始，
  开始新一轮。
- summary 页面上**没有任何进度标记**，也没有 `form[name="answerform"]`，
  因此题目检测器在这一页只会报告「找不到题目区域」—— 这正是必须单独判定 summary
  的原因，否则会把结束页误判成识别失败并弹出降级警告。
- 摘要在同一 URL 下渲染（`/e/addition_4`），**没有发生页面跳转**。

### 10.5.0 结束页的切换**不是原子的**

实测发现，点击 `Show summary`（或最后一题答对后 KA 自行切换）时，DOM 会经过一个
**中间状态**：

| 时刻 | `form[name="answerform"]` | 进度标记 |
|---|---|---|
| 切换中 | **已消失** | **仍然存在** |
| 切换完成 | 已消失 | 已消失 |

在中间状态下，`isSummaryPage()`（要求「无答题表单」**且**「无进度标记」）会返回
`false`；只有等到进度标记也被移除后才返回 `true`。

**对实现的影响：**结束页检测必须**反复检查**（本实现每 700 ms 一次），
不能只检查一次。验证脚本也因此改为轮询等待结束页稳定，而不是单次判断 ——
单次判断会偶发地卡在这个中间状态上，把一次正常的结束误报为「没到达结束页」。

### 10.5.1 「加试题」阶段的不变式

用同一套判定跑「进入加试题」这一步，结果仍是 **否**（有 `answerform`、有进度标记），
因此不会被误判为结束页。加试题与普通题共用同一套题目区域与进度标记结构，
计时与识别行为一致。

### 10.7 卡片插入位置：用测量决定，而不是靠类名猜

**背景：** 早期把「本轮每题用时」卡片插到结束页卡片之后，用户反馈**遮住了网页原有的
结果信息**。用真实页面测量后确认这不是错觉，而且原因很反直觉。

#### 10.7.1 结束页是一个「零高度 + 绝对定位」的固定高布局

逐层测量祖先元素的计算样式：

| 元素 | rect | display | 说明 |
|---|---|---|---|
| `div[content-panel-wrapper]` | y 375..1000，h 625 | flex | 练习面板，恰好填满视口剩余高度 |
| `div[content-library-content-panel]` | y 375，**h 0** | — | 内容高度为 **0** |
| `div[content-library-footer]` | y 934，**h 0**（改版后 66） | — | 高度为 **0** |
| `div[eot-phantom-user-registration]` | y 617，**h 0** | flex / row | 结束页卡片，高度为 **0** |

这些容器的**高度是 0，但内容照常绘制**（内容由绝对定位的后代渲染，不参与文档流）。
后果是：**任何插到它们后面的兄弟节点，都会画在这些「溢出」的内容之上。**

实测证据（把卡片插到结束页卡片之后）：

```
card rect          = {x:417, y:665, w:1023, h:670}
被卡片遮挡的可见文本 = 193 个元素
  其中包含：Exercise complete! / 4/4 correct / Want to save your progress?
            Try again / Up next: Quiz 2 / Unit 3..14 / Course challenge
```

即用户的反馈完全成立 —— 卡片同时盖住了成绩、注册提示，以及页脚自己的
「Try again」按钮。

另外发现 `flex: 1 0 100%` 这种「占满一行」的防御式写法在这里是**有害**的：
父容器是 column flex，`flex-grow: 1` 让卡片被拉伸到容器整高（五行表格量到 625px）。
改为 `flex: 0 0 auto` 后卡片回到自然高度（实测 255px）。

#### 10.7.2 候选位置实测对比

用一个与卡片同尺寸的探针元素依次插到各个位置，统计它与**练习面板自身文本**的重叠
（只看练习结果 UI；课程侧栏、掌握度网格、以及 `position: fixed` 的捐款浮层都不算）：

| 候选位置 | 与练习结果 UI 重叠 | 是否在视口内可见 |
|---|---|---|
| **练习内容区之前**（`[class*="exercise-chrome-content"]`） | **0** | **是**（y 503..713） |
| 追加到练习内容区末尾 | 0 | 否（y 1097..1307，需滚动） |
| 追加到 `.bibliotron-exercise` | 10 | 部分 |
| 追加到 `[data-testid="content-panel-wrapper"]` | 9 | 部分 |
| 页脚之前 | 12 | 是 |
| `content-panel-wrapper` 之后 | 9 | 是 |
| 追加到 `document.body` | 8 | 部分 |

**结论：** 采用「插到练习内容区之前」。

- 它**不遮挡任何练习结果 UI**（0 重叠）；
- 且落在视口内（y 503..713），**不需要滚动**就能看到；
- 练习内容自身被向下推，在它自己的 `overflow: auto` 滚动区内滚动。

选择器用的是**语义类名** `[class*="exercise-chrome-content"]`
（真实 DOM 为 `div._18402u36.exercise-chrome-content-for-mobile-zoom`），
不是哈希类名。

#### 10.7.3 最终验证结果

真实扩展卡片（不是探针）在结束页上的实测：

```
card rect            = {x:417, y:519, w:1023, h:255}   ← 自然高度，未拉伸
遮挡的可见元素数量   = 0
```

### 10.6 Skip 确认流程（复核）

| 步骤 | 观测结果 |
|---|---|
| 点击 `exercise-skip-button` | 弹出确认框：`Are you sure? Skipped questions will count as incorrect.` |
| 确认框按钮 | `[aria-label="Close modal"]`、`Yes, skip`、`Cancel` |
| 点击 `Yes, skip` | 进度状态由 `incomplete` → `incorrect`；提示/分步解答自动展开 |
| 点击 `Yes, skip` 后的前进 | **没有**自动跳到下一题；按钮仍是 `exercise-check-answer`，需再作答才出现 `Next question` |

**对实现的影响：**

1. 只有**确认**跳过才算跳过。实现中把「点击 Skip」与「题目状态离开 `incomplete`」
   两个条件合起来判断，因此点 `Cancel` 不会停表。
2. 由于跳过之后仍需作答才能前进，可能出现在同一题上「先跳过、再答对」的情况。
   实现中第一完成原因胜出（记录为 `skipped`），不会为同一题产生两条记录。


---

## 11. 答错后重答正确：进度标记不会变成 correct

**方式：** 先故意提交一个错误答案（正确值 +7），等判定为错误后，再提交正确答案。
这是用户报告的一个缺陷的根因调查。

### 11.1 观测结果

**进度标记保留的是「第一次作答」的判定**，重答正确不会把它改成 `correct`：

| 阶段 | 进度 testid | `exercise-check-answer` | `exercise-next-question` |
|---|---|---|---|
| 未作答 | `exercise-progress-0-incomplete-current` | 存在（`Check`） | 无 |
| **答错后** | `exercise-progress-0-incorrect-current` | 存在（文案变成 `Check again`） | 无 |
| **重答正确后** | **仍是 `exercise-progress-0-incorrect-current`** | **消失** | **出现** |

也就是说：

- **状态字**只反映第一次作答 → 重答正确时**没有任何状态变化**；
- 但**按钮发生了替换**：`Check` 被「下一题」控件取代。

### 11.2 对实现的影响（这是一个真实缺陷）

原实现只用「进度状态字」判断「答对了」：

```
incomplete -> correct   ⇒ 停表
```

这在**第一次就答对**时有效（也够快，因为观察器立刻触发），
但**答错后重答正确时永远不触发** —— 状态字停在 `incorrect` 不动，
于是计时一直跑下去。这正是用户报告的现象。

**修复：** 增加第二个信号，二者互补且幂等：

| 信号 | 覆盖场景 | 触发时机 |
|---|---|---|
| 进度状态字变为 `correct` | **第一次**就答对 | 观察器触发，立即（<250 ms） |
| `Check` 按钮被「下一题」控件替换 | **任意一次**答对（含重答） | 受节流的页面检查，≈700 ms |

两个信号谁先触发都可以：先触发者写入待写记录，后触发者因
`pendingRecord !== null` 直接返回，不会重复记录。

**回归测试：**

```
tests/question-detector.test.ts
  site-profile: isQuestionFinished
    > is false right after a WRONG answer (Check becomes "Check again")
    > is true after a correct RETRY, where the status word stays "incorrect"
  completionTriggerFor + isQuestionFinished cover both answer paths
    > correct retry is NOT caught by the status word, which is why the button check exists
```

端到端验证脚本也新增了对应场景（真实的「先答错、再答对」），并断言：
答错时计时**继续**，重答正确后计时**停止**且数值冻结。

### 11.3 顺带确认：记录里的「第一次提交对错」仍然正确

由于状态字保留第一次的判定，记录中的 `firstSubmissionOutcome` 在
「先错后对」的题目上会是 `incorrect` —— 这与需求 2.4
「如果第一次回答错误，还要保存第一次提交答案的时间戳」一致，
结束页表格上该题显示「答错」标记也是准确的（它表示**第一次提交**的结果，
而不是这题最终有没有做对）。

---

## 12. SAT test-prep 页面类型（`/test-prep/...`）

**背景：** 用户报告计时面板在「未识别」的页面上也显示，并给出 4 个 SAT test-prep URL
作为应该计时的页面。因此先采集这 4 个 URL 的真实 DOM，确认现有选择器是否命中。

**方式：** 真实 Edge + CDP。加载页面 → 记录选择器命中情况 → 若有「开始」控件则点击 →
再次记录。脚本见 `scripts/capture/cdp-page-check.mjs`。

### 12.1 结论：结构完全相同，无需新增选择器

| 页面类型 | URL 片段 | 开始前 | 点击 `Let’s go` 之后 |
|---|---|---|---|
| 练习（exercise） | `/e/v2-graphs-of-linear-systems-…-1` | **直接就是题目** | — |
| 测验（quiz） | `/quiz/x0fcc98a58ba3bea7:algebra-easier-quiz-2` | 介绍卡片 | 题目，**5** 个进度点 |
| 单元测试（unit test） | `/test/x0fcc98a58ba3bea7:algebra-easier-unit-test` | 介绍卡片 | 题目，**10** 个进度点 |
| 课程挑战（course challenge） | `/test/x0fcc98a58ba3bea7:course-challenge` | 介绍卡片 | 题目，**30** 个进度点 |

开始之后，三种页面与已验证的普通练习页**结构完全一致**：

```
form[name="answerform"]            ✓ 存在
.framework-perseus / .perseus-renderer  ✓ 存在
exercise-progress-<i>-<state>[-current] ✓ 存在（5 / 10 / 30 个）
exercise-check-answer              ✓ 存在
exercise-skip-button               ✓ 存在
content-library-footer             ✓ 存在
data-exercise-id                   ✓ 存在（每页不同）
```

因此**不需要为 SAT 页面新增任何选择器** —— 进度索引、题目区域、按钮的规则全部沿用。
实测这些页面还出现了 `input-with-examples`、`select`、`textarea`、`checkbox` 等多种
控件，`widgetSignatureOf()` 的通用标记可以覆盖。

### 12.2 关键发现：开始卡片会让「结束页」判定误报

测验 / 单元测试 / 课程挑战在开始**之前**显示一张介绍卡片：

```
Quiz 2
Time for a quiz?
Get ready for questions on the unit so far.
5 questions • 5 - 10 minutes
[ Let’s go ]
```

它的 testid 是 **`start-task-card-summary`**。

从外部看，这个状态与「练习结束页」**一模一样**：练习外壳在、没有答题表单、没有进度标记。
朴素的结构判定会把三个页面全部报成 `isSummaryPage = true` —— 实测确实如此：

| 页面 | 开始前 `isSummaryPage` | 实际 |
|---|---|---|
| quiz | **true（误报）** | 还没开始 |
| unit test | **true（误报）** | 还没开始 |
| course challenge | **true（误报）** | 还没开始 |

**修复：** `isSummaryPage()` 增加一条排除 —— 页面上存在 `start-task-card-summary` 时
一律不算结束页。同时新增 `isStartCardPresent()`，让弹出面板把这种情况说明为
「尚未开始：请点击页面上的「Let's go」」，而不是「此页面暂不支持」。

### 12.3 开始卡片上的「开始」按钮文案

按钮文案是 **`Let’s go`**，用的是**排版撇号 U+2019**，不是 `Start`。
（早期探针按 `/^start/` 匹配，因此完全没有找到它 —— 记录在此以免重复踩坑。）
验证脚本与文档统一按 `let.s go` 匹配。

### 12.4 计时面板的显示时机

结合上面的观测，面板的显示规则确定为「**只有当真的在给某道题计时时才显示**」：
开始卡片上、课程页上、视频页上都不显示；点了 `Let’s go` 且题目出现后立即显示。
详见 `docs/user-guide.md` 的「面板什么时候出现」与 `README.md` 的「架构与不变量」。

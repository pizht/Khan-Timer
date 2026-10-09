# 交互行为观察记录

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

# 兼容性：已验证页面类型与人工测试结果

本文件是需求文档「交付物」第 7 项：**已验证页面类型清单和人工测试结果**。

需求文档第 4 节要求把兼容性承诺分级，并明确要求：
**「测试清单未覆盖的页面不得标记为『已验证支持』。」**

---

## 测试环境

| 项目 | 值 |
|---|---|
| 浏览器 | Microsoft Edge **154.0.4258.62**（Chromium，macOS arm64） |
| 扩展规范 | Manifest V3 |
| 登录状态 | **未登录**（未索取任何凭证） |
| 测试日期 | **2025-10-09** |
| 扩展版本 | 0.1.0 |

**兼容性承诺以本次测试的浏览器版本为准。** 需求文档第 7 节要求具体测试版本记录在
发布说明中，即上表。

---

## 一、已验证支持（`Edge-verified`）

### 1.1 练习页（Exercise，URL 含 `/e/`）

| 项目 | 值 |
|---|---|
| 页面入口 | `/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4` |
| 页面标题 | Add within 1000 |
| 题型 | 数值输入题（Perseus `input-with-examples`，竖式加法） |
| 题量 | 4 题 |
| 切题方式 | 答对后页面出现 `Next question` 按钮，点击进入下一题 |
| 验证手段 | `node scripts/verify-extension.mjs`（加载 `dist/` 到真实 Edge） |

### 人工测试步骤与结果

每一步都是需求文档第 9 节测试计划中的场景。结果由脚本输出，非人工声称。

| # | 操作步骤 | 预期结果 | 实际结果 | 通过 |
|---|---|---|---|---|
| 1 | 打开上述练习页 | 自动出现悬浮面板并开始正计时 | 面板出现，`0:00` 起走，模式「正计时」 | ✅ |
| 2 | 等待 3 秒 | 计时数值随时间增长 | `0:00 → 0:03` | ✅ |
| 3 | 点击面板「暂停」，等待 2.5 秒 | 数值不再增加 | `0:03 → 0:03` | ✅ |
| 4 | 点击「继续」，等待 2.6 秒 | 从暂停值继续累积 | `0:03 → 0:05` | ✅ |
| 5 | 点击「重置本题」 | 只把当前题归零 | `0:05 → 0:00` | ✅ |
| 6 | 在输入框填入 **正确答案**（脚本从题干解出 `608+251=859`）并点 Check | 出现答对反馈；**计时不得重置** | 计时持续增长 `0:00 → 0:05` | ✅ |
| 7 | 点击页面出现的 `Next question` | 保存上一题记录；计时重置为新题 | `0:05 → 0:03`；进度 `1 of 4 → 2 of 4`；`已记录 1` | ✅ |
| 8 | 打开扩展弹出面板 | 可打开、显示设置与记录 | 面板可打开，`已保存 1 条` | ✅ |
| 9 | 在弹出面板把模式改为「倒计时」、限时 5 秒 | 设置写入本地存储；**当前题实时生效** | 存储写入成功；面板模式变「倒计时」 | ✅ |
| 10 | 等待超过 5 秒 | 显示明显的超时状态，**不自动提交、不自动跳题** | `status-expired`，`限时 6s / 超时 +0:10`，页面仍在原题 | ✅ |
| 11 | 在弹出面板点击「清除全部记录」 | 记录清空，**设置保留**；清空后按钮自动隐藏；结果提示出现在「本地记录」卡片内 | `已保存 0 条`，`#clear-records` 隐藏，`#records-hint` 显示 `记录已清除`；设置卡片无提示；设置仍为倒计时/6 秒 | ✅ |
| 12 | 刷新页面 | 设置仍然保留 | 设置持久化（`chrome.storage.local`） | ✅ |

**汇总：12 / 12 通过。** 脚本另有 18 项结构性检查（面板注入、Shadow DOM 隔离、
诊断信息完整等），合计 **67 / 67 通过**。

### 1.2 本轮追加验证的三项行为

用户在本轮提出三项行为变更，均已在真实 Edge 上验证通过（合计 67/67 项检查通过）。

| # | 行为 | 验证项 | 结果 |
|---|---|---|---|
| 1 | **确认 Skip 后停止本题计时** | `skip asks for confirmation first`、`the skip confirmation can be triggered`、`confirming a skip stops the timer`、`answering after a skip does not resume the stopped timer`、`the skipped question can be advanced past` | ✅ 跳过确认后数值冻结（`0:04 → 0:05` 后保持不变）；点 Cancel 不停表 |
| 2 | **答对后停止本题计时** | `the page accepted the correct answer`、`answering correctly stops the timer`、`the panel shows the completed state`、`the pause control is disabled once the question is done`、`the frozen value does not creep upwards afterwards` | ✅ 面板转 `已完成`、暂停按钮禁用、3.5 s 后仍为 `0:04`；答错时**不停表**（可重试） |
| 3 | **结束页显示本轮每题用时** | `the end-of-exercise summary screen is reached`、`the summary card is injected`、`the summary lists every question of this run`、`each summary row shows a duration`、`the summary shows a total`、`the summary marks the skipped question`、`the summary tags the bonus question`、`the summary does not print any tag twice`、`all saved records belong to a single run`、`the summary shows exactly the records saved for this run`、`every record carries a question outcome` | ✅ 结束页出现「本轮每题用时」卡片，行数与本轮保存的记录数一致 |

实测卡片内容（一次完整的 4 题 + 1 加试题）：

```
本轮每题用时        共 5 题 · 合计 0:19
第 1 题 答对   正计时   0:04
第 2 题 已跳过  正计时   0:05
第 3 题 答对   正计时   0:03
第 4 题 答对   正计时   0:03
第 5 题 加试   正计时   0:03
```

### 1.2.1 结束页卡片的两项界面调整

用户随后提出两项界面要求，均已实现并在真实结束页上验证：

| # | 要求 | 实现与验证 |
|---|---|---|
| 1 | 不要显示模式栏 | 表格改为**两列**（题目、用时）。端到端断言表头恰为 `['题目','用时']`、每行恰有 2 个单元格、且卡片内不出现「正计时/倒计时」字样。超时仍由「超时」标记表达。 |
| 2 | 不应覆盖网页原有内容 | 卡片改为插在**练习内容区之前**，把原有内容向下推。在真实结束页上测量卡片与练习面板自身文本的重叠：**0 处**（改动前为 192 处，包含「Exercise complete!」「4/4 correct」「Want to save your progress?」「Try again」「Up next」）。选取依据是 11 个候选位置的实测对比，见 `references/observations.md` §10.7。 |

补充：卡片高度也从被拉伸的 625px 回到自然高度 255px —— 原因是 `flex-grow: 1`
在 column flex 容器里会把卡片撑满容器高度。

### 1.2.2 结束页卡片可折叠

用户要求「这个时间总览面板可以折叠」，已实现并验证：

| 验证项 | 结果 |
|---|---|
| 卡片提供折叠控件 | ✅ `hasToggle=true`，`aria-label=折叠用时明细` |
| 默认展开，明细已排版 | ✅ `collapsed=false visibleRows=4/4` |
| 折叠后隐藏每题明细 | ✅ `collapsed=true visibleRows=0/4` |
| 折叠后仍显示标题与合计 | ✅ 文本含「本轮每题用时」「共 4 题 · 合计 0:19」 |
| 状态同步给无障碍属性 | ✅ `data-khan-timer-summary-collapsed=true`、`aria-expanded=false` |
| 再次展开恢复明细 | ✅ `collapsed=false visibleRows=4` |
| 折叠偏好被持久化 | ✅ 存储中 `summaryCollapsed=true` |

实现要点：

- 折叠控件放在标题行内，**整行可点**；按钮也可用键盘操作（`Tab` + `Enter`/`空格`）。
- 明细虽然被折叠，但在 DOM 中保留，展开是瞬时的；验证脚本因此用**实际渲染高度**
  而不是 DOM 节点数来判断是否真的隐藏了。
- 折叠状态写入本地设置（`summaryCollapsed`），下次打开结束页保持折叠。
- 折叠控件的点击会 `stopPropagation`，不会传到可汗学院自己的文档级点击处理。

### 1.3 本轮采集修正：`addition_4` 有 bonus question

驱动整轮时发现最后一道普通题之后的控件文案是 **`Bonus question`**（不是
`Show summary`），点击后**进度索引回到 0**，做完加试题才出现 `Show summary`。

这修正了早期「索引倒退＝练习重做」的误读。实现上：

- 结束页表格**是这套题的题号表**：每行按记录自带的题号（页面进度索引 + 1）排列；
  某个题号没有计时数据时写「数据缺失」而不是把下一题顶上来；
- 索引倒退的那一行（加试题）排在编号题目之后并标记「加试」，
  因此不会出现两个「第 1 题」；
- 不再把索引倒退当作新一轮的开始。

### 1.4 页面类型覆盖：SAT test-prep

用户要求计时面板「只在真正有题目的页面显示」。为此实测了 SAT test-prep 的四类页面
（`/test-prep/v2-sat-math/...`）：

| 页面类型 | 开始后是否被识别 | 分级 |
|---|---|---|
| 练习 `/e/` | ✅ 直接识别（进度点 4） | `Automated-tested` |
| 测验 `/quiz/` | ✅ 点 `Let’s go` 后识别（进度点 5） | `Automated-tested` |
| 单元测试 `/test/` | ✅ 点 `Let’s go` 后识别（进度点 10） | `Automated-tested` |
| 课程挑战 `/test/` | ✅ 点 `Let’s go` 后识别（进度点 30） | `Automated-tested` |

**无需为这些页面新增选择器**：开始之后它们与已验证的普通练习页结构完全一致。

同时修掉一个真实缺陷：这三类页面开始前的「介绍卡片」会让结束页判定**误报为 true**
（看起来同样是「有练习外壳、没有答题表单、没有进度标记」）。已按卡片自身的
`data-testid="start-task-card-summary"` 排除，并在弹出面板中说明为
「尚未开始：请点击页面上的「Let's go」」。

### 1.5 面板显示时机（本轮新增）

面板的显示与题目识别状态同步：**只有真的在给某道题计时时才显示**。

| 场景 | 面板 | 验证 |
|---|---|---|
| 正在计时的题目 | 显示 | ✅ `the panel appears once the quiz has a question` |
| 课程页（没有题目） | 不显示 | ✅ `no panel on a course page with nothing to time` |
| 测验的介绍卡片 | 不显示 | ✅ `no panel before the quiz is started` |
| **单页应用内切到另一个练习（含它的介绍卡片）** | 不显示 | 单元测试 `tests/controller.test.ts`（未跑真实站点，见下） |
| 结束页 | 不显示 | ✅ `the float panel is hidden on the summary screen` |
| 识别失败（**未识别**） | 不显示，且**暂停本题计时** | 单元测试（见 1.5.2）；「没有 engine 就没有面板」只覆盖了「从未识别到题目」的情形 |

识别失败时的可见提示改由**扩展弹出面板**承担（显示「未找到题目区域」、
命中策略、错误列表），满足需求 8.3「提供可见提示**或**可用的手动恢复方式」中的前者。

### 1.5.1 切换练习（本轮修复，未跑真实站点）

可汗学院是单页应用：从练习 A 切到练习 B 只换地址，页面不重新加载。此前旧练习的
计时器会留在内存里，于是：

- 练习 B 的「Ready to practice?」页面上显示着练习 A 的读数，并且还在继续增长；
- 若 B 的第一题和 A 停在同一进度（都是「1 of N」），它会被当成「题目没变」，
  接着 A 那份进行中的会话被当成一次普通切题结算掉 —— 回到 A 时已累计的用时消失，
  停表待写的那条记录也一起丢掉。

现在：地址一变即作废旧题目身份；只要页面已不属于当前练习，本题就**冻结并按
`session:<练习路径>` 暂存**（答对/跳过的待写记录立刻落盘），面板不再显示旧练习读数；
回到同一题时从离开时的读数继续，在另一个练习里花的时间不计入。

**回到练习做完整轮后，结束页是这套题的题号表。** 记录里带着「哪个练习、第几题、本地
题目指纹」，卡片取数先按练习路由再收到本轮；行按**题号**排列，某个题号没有计时数据就写
「数据缺失」而不是把下一题顶上来；同一题两段用时相加；加试题排在编号题目之后。
记录落盘另走**单条串行队列**（`createRecordQueue`）：`records` 是「读-追加-写回」，
`chrome.storage` 没有事务，并发写入会让后写的覆盖前一条（卡片就少一行），
卡片在读取前会先等队列排空。

验证方式为 jsdom 单元测试（`tests/controller.test.ts`：切换练习 3 例 + 结束页题号模型
3 例；`tests/storage.test.ts`：按练习取数 4 例 + 写入队列 3 例；`tests/summary-view.test.ts`：
行序模型 6 例），**尚未**在真实 Edge + 真实站点上用
`scripts/verify-extension.mjs` 重跑；该脚本需要真实登录环境并逐题作答，
已在 `docs/known-limitations.md` 第 22 条如实记录。

### 1.5.2 识别：未识别 → 暂停 → 同一道题恢复（本轮新增）

页面不再给出可用的题目标识时（找不到题目区域，或区域里没有任何可用来区分题目的
信号），面板的「识别」一栏就是 **未识别**。此时：

1. **隐藏**悬浮面板；
2. **暂停**本题计时——读不出来的这段时间不计入这道题；
3. 引擎**只暂停、不丢弃**：已累计用时、第一次提交时间戳、本轮 `runId` 都保留；
4. 重新识别到**同一道题**时从暂停值**继续**（不是从零开始）；
5. 若识别到的是**另一道题**，按正常切题结算——被暂停的那道题照样写入记录，
   因此**仍然出现在结束页的「本轮每题用时」里**；
6. **学生手动按下的「暂停」不会被自动继续**（只有扩展自己因识别丢失而暂停的才会）。

暂停的这段时间记入该题的 `pausedMs`，结束页那一行会显示 `用时 0:12` 加一行小字
`暂停 0:31`（合计只算用时）。记录的 `wasPaused` 仍然只表示「学生按过暂停」。

| 场景 | 面板 | 计时 | 验证 |
|---|---|---|---|
| 题目区域消失（换题途中） | 不显示 | 暂停 | jsdom 端到端 `hides the panel, freezes the clock and resumes the same question from the frozen value` |
| 同一道题重新出现 | 显示 | 从暂停值继续 | 同上 + `QuestionDetector` 的 `re-evaluates the moment the region comes back, with nothing else changing` |
| 重新出现的是另一道题 | 显示新题 | 旧题结算并落盘 | 同上（会话/记录断言） |
| 学生手动暂停后识别丢失再恢复 | 显示 | **保持暂停** | `never undoes a pause the learner asked for` |
| 中途被暂停的题做完整个 practice | — | — | 结束页 3 行都齐全，被暂停那行用时与暂停用时分开：`keeps a question paused mid-way in the end-of-exercise summary` |

可见提示的落点在**扩展弹出面板**：`未识别到题目：本题计时已暂停，重新识别到本题后
自动继续`。**未跑真实站点**（浏览器里无法可靠制造这一幕），已在
`docs/known-limitations.md` 第 23 条如实记录。

页内警告 `无法可靠识别当前题目（<原因>）。…` **只在面板可见且页面确实读不出题目时**
渲染；一旦同一道题重新被识别（面板回来、时钟继续），这条警告就随之清除，
不会留在正在计时的面板上（用户报告「与现实不符」的缺陷，见
`tests/controller.test.ts` → `does not keep the not-found warning after the same question is
identified again`）。

### 重要限制：连续切题次数不足

验收标准 8.3 要求「对已验证的每种页面类型，至少测试连续完成 **10 次** 题目切换」。

**本版本未满足该条。** 实际完成的连续切题次数：

- 未加载扩展的交互采集：**3 次**（进度索引 0→1→2→3）
- 加载扩展的端到端验证：**1 次**（进度 1 of 4 → 2 of 4）

原因是该练习只有 4 题，且每次切题都要先答对，自动化的连续切题上限受题量限制。
要达到 10 次需要人工在多套练习上连续操作。详见
[`known-limitations.md`](known-limitations.md) 第 1 条。

---

## 二、尝试支持（未独立验收）

这些页面结构**类似于**已验证页面，扩展会尝试识别，但**没有**通过独立验收：

| 页面类型 | 入口 | 依据 |
|---|---|---|
| 其他练习页 | `/math/.../e/<slug>` | 首屏结构已观察（`form[name="answerform"]` + `exercise-progress-*`），但未驱动验证切题 |
| 测验（Quiz） | `/math/.../quiz/<slug>` | 首屏 DOM 已抓取；URL 形态为 `/quiz/<slug>`；进度标记结构同练习；**切题流程未验证** |
| 单元测试（Unit test） | `/math/.../test/<slug>` | 仅 URL 形态已知，**未抓取 DOM** |
| 其他课程 / 年级 | 任意 | 同一套 Perseus 渲染器，但**未验证** |
| 本地化站点 | `*.khanacademy.org` | 内容脚本会注入；选择器不依赖文案，但**未验证** |

---

## 三、未支持 / 待适配（`Unverified`）

| 场景 | 为什么 | 扩展的表现 |
|---|---|---|
| 选择题（radio / choice） | 该题型的 DOM 未实际观测 | 会用同一套区域/进度识别；题型签名参与指纹 |
| 表达式输入、下拉题、拖拽题 | 未观测 | 同上 |
| 交互图（interactive-graph）等复杂 widget | 未观测 | 同上 |
| 登录后的专属内容（课程进度、指派作业、已完成练习） | 采集时未登录，且不索取凭证 | 同上 |
| Khan Academy 的 A/B 测试变体 | 无法枚举 | 识别不确定时隐藏面板并**暂停**本题计时，弹出面板给出可见提示（见 1.5.2） |
| 课程目录页、视频页 | 本就没有题目区域 | 面板显示「未找到题目区域」，不计时 |
| 上一题 / 下一题导航（页面自带） | 已验证练习页未提供该控件 | 若出现，会作为一次可靠的题目变化处理 |

### 未支持时的行为（需求文档第 4 节要求）

需求 4 明确：「无法提供可靠的题目区域信号……此时扩展应显示未能可靠识别的提示，
**且不得伪装成自动切题已正常工作**。」

实现符合该要求：

> 截图 `references/screenshots/overlay-degraded-unrecognised.png` 是**历史截图**：
> 它拍摄于旧的「保持计时不变」行为下（面板仍显示 `识别：未识别` 与
> `计时保持不变，可用"重置本题"手动开始。`）。当前行为已改为下面列出的
> 「隐藏面板 + 暂停计时」，该截图仅作对照，不再代表当前界面。

- 面板「识别」一栏显示 **未识别** 或 **弱信号**；
- **未识别**时面板**隐藏**、本题计时**暂停**，扩展弹出面板给出可见提示：
  「未识别到题目（question region not found）。本题计时已暂停，重新识别到本题后
  会自动继续。」（面板隐藏，所以这条提示落在弹出面板里）；
- 「弱信号」时面板仍然显示（识别可用，只是证据较弱），页脚显示「识别不确定」；
- 重新识别到**同一道题**即自动继续计时；识别到另一道题则正常结算，
  被暂停的那道题仍会出现在结束页的用时统计里；
- **不重置、不丢弃**当前计时数据，不会静默乱重置。

---

## 四、验证分级凭据

| 等级 | 本项目对应的具体对象 | 凭据 |
|---|---|---|
| `Edge-verified` | 练习页 `addition_4`：面板注入、正计时自动开始、暂停/继续/重置、**答对即停表**、**确认跳过即停表**、**提示展开不重置计时**、切题结算并保存记录、**结束页「本轮每题用时」**、倒计时超时状态、弹出面板读写存储、清除记录 | `scripts/verify-extension.mjs` 输出，67/67 |
| `Automated-tested` | 练习页 `addition_4`：进度索引 0→1→2→3、答题前后区域文本一致、反馈浮层位置、提示展开导致区域文本 3.5 KB→23 KB 而索引不变 | `references/observations.md` 第 1、2、3 节 |
| `Observed` | 练习 `rounding-to-the-nearest-ten-or-hundred`、测验 `quiz-1` 的首屏 DOM | `references/collection-report.md` 第 2 节、`references/snapshots/` |
| `Unverified` | 本文件第二、三节列出的全部内容 | — |

---

## 五、页面改版后的重新验收

Khan Academy 更新页面后，兼容性可能失效。重新验收只需两条命令：

```bash
pnpm run verify                        # 类型 + 单元测试 + 构建 + 产物检查
pnpm run verify:edge                    # 真实 Edge 端到端（67 项）
```

若第二条命令出现失败，输出会直接给出失败的检查项与实测值，便于定位是哪一个
选择器失效。所有站点选择器集中在 `src/site-profile.ts` 单文件，且每条都标注了
建立方式与降级顺序。

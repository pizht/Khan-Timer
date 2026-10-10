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
| 11 | 在弹出面板点击「清除全部记录」 | 记录清空，**设置保留** | `已保存 0 条`；设置仍为倒计时/6 秒 | ✅ |
| 12 | 刷新页面 | 设置仍然保留 | 设置持久化（`chrome.storage.local`） | ✅ |

**汇总：12 / 12 通过。** 脚本另有 18 项结构性检查（面板注入、Shadow DOM 隔离、
诊断信息完整等），合计 **60 / 60 通过**。

### 1.2 本轮追加验证的三项行为

用户在本轮提出三项行为变更，均已在真实 Edge 上验证通过（合计 60/60 项检查通过）。

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

### 1.3 本轮采集修正：`addition_4` 有 bonus question

驱动整轮时发现最后一道普通题之后的控件文案是 **`Bonus question`**（不是
`Show summary`），点击后**进度索引回到 0**，做完加试题才出现 `Show summary`。

这修正了早期「索引倒退＝练习重做」的误读。实现上：

- 结束页表格**按答题顺序编号**（第 1、2、3…题），不使用页面索引，
  因此不会出现两个「第 1 题」；
- 索引倒退的那一行标记为「加试」；
- 不再把索引倒退当作新一轮的开始。

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
| Khan Academy 的 A/B 测试变体 | 无法枚举 | 识别不确定时保守降级并提示 |
| 课程目录页、视频页 | 本就没有题目区域 | 面板显示「未找到题目区域（此页面暂不支持）」，不计时 |
| 上一题 / 下一题导航（页面自带） | 已验证练习页未提供该控件 | 若出现，会作为一次可靠的题目变化处理 |

### 未支持时的行为（需求文档第 4 节要求）

需求 4 明确：「无法提供可靠的题目区域信号……此时扩展应显示未能可靠识别的提示，
**且不得伪装成自动切题已正常工作**。」

实现符合该要求，并已由截图佐证
（`references/screenshots/overlay-degraded-unrecognised.png`）：

- 面板「识别」一栏显示 **未识别** 或 **弱信号**；
- 显示黄色警告：「无法可靠识别题目变化（question region not found）。
  计时保持不变，可用『重置本题』手动开始。」
- 页脚显示「识别不确定」；
- **保持当前计时不变**，不会静默乱重置。

---

## 四、验证分级凭据

| 等级 | 本项目对应的具体对象 | 凭据 |
|---|---|---|
| `Edge-verified` | 练习页 `addition_4`：面板注入、正计时自动开始、暂停/继续/重置、**答对即停表**、**确认跳过即停表**、**提示展开不重置计时**、切题结算并保存记录、**结束页「本轮每题用时」**、倒计时超时状态、弹出面板读写存储、清除记录 | `scripts/verify-extension.mjs` 输出，60/60 |
| `Automated-tested` | 练习页 `addition_4`：进度索引 0→1→2→3、答题前后区域文本一致、反馈浮层位置、提示展开导致区域文本 3.5 KB→23 KB 而索引不变 | `references/observations.md` 第 1、2、3 节 |
| `Observed` | 练习 `rounding-to-the-nearest-ten-or-hundred`、测验 `quiz-1` 的首屏 DOM | `references/collection-report.md` 第 2 节、`references/snapshots/` |
| `Unverified` | 本文件第二、三节列出的全部内容 | — |

---

## 五、页面改版后的重新验收

Khan Academy 更新页面后，兼容性可能失效。重新验收只需两条命令：

```bash
pnpm run verify                        # 类型 + 单元测试 + 构建 + 产物检查
pnpm run verify:edge                    # 真实 Edge 端到端（60 项）
```

若第二条命令出现失败，输出会直接给出失败的检查项与实测值，便于定位是哪一个
选择器失效。所有站点选择器集中在 `src/site-profile.ts` 单文件，且每条都标注了
建立方式与降级顺序。

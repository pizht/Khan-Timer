# 练习页面 data-testid 清单

从真实 Edge 渲染后的练习页 DOM 中提取（未登录，Edge 154，页面路径
`/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4`）。

「题目区域内」= 该元素是否位于 `form[name="answerform"]` 之内。
只有区域内的元素才会进入题目指纹；区域外的元素变动不会影响计时。

共 **64** 个不同的 data-testid。

| data-testid | 元素 | 出现次数 | 文案 / aria-label | 题目区域内 |
|---|---|---|---|---|
| `banner-kind-icon` | `span` | 1 | info |  |
| `learn-menu-dropdown` | `button` | 1 | Explore |  |
| `learn-menu-button` | `span` | 1 | Explore |  |
| `courses-menu-instructions` | `div` | 1 |  |  |
| `learn-menu` | `nav` | 1 | Browse By StandardsMath: Florida B.E.S.T.Mat |  |
| `end-icon` | `span` | 1 |  |  |
| `math` | `span` | 9 | Math: Florida B.E.S.T. |  |
| `caret-icon` | `span` | 18 |  |  |
| `test-prep` | `span` | 1 | Test prep |  |
| `ela` | `span` | 1 | English language arts (ELA) |  |
| `science` | `span` | 1 | Science |  |
| `humanities` | `span` | 1 | Social studies |  |
| `computing` | `span` | 1 | Computing |  |
| `economics-finance-domain` | `span` | 1 | Economics |  |
| `college-careers-more` | `span` | 1 | Life skills |  |
| `partner-content` | `span` | 1 | Partner courses |  |
| `khan-for-educators` | `span` | 1 | Khan for educators |  |
| `navbar-search-button` | `button` | 1 | Search |  |
| `navbar-search-button-start-icon` | `span` | 1 |  |  |
| `navbar-search-button-inner-label` | `span` | 1 | Search |  |
| `header-logo` | `a` | 1 | Khan Academy |  |
| `header-donate-link` | `a` | 1 | Donate |  |
| `external-icon` | `span` | 2 |  |  |
| `mobile-search-button` | `a` | 1 | Search for courses, skills, and videos |  |
| `mobile-header-menu-button` | `button` | 1 | Open menu |  |
| `responsive-nav-menu` | `div` | 1 | menu |  |
| `donate-banner` | `div` | 1 | Every $1 = 100 minutes of learning.“Free to  |  |
| `close-donate-banner` | `button` | 1 | close |  |
| `mission-text-block` | `div` | 1 | Every $1 = 100 minutes of learning.“Free to  |  |
| `mission-content-headline` | `p` | 1 | Every $1 = 100 minutes of learning. |  |
| `mission-content-copy` | `p` | 1 | “Free to use. Not free to make. With less th |  |
| `gift-amount-0` | `input` | 1 |  |  |
| `gift-amount-1` | `input` | 1 |  |  |
| `gift-amount-2` | `input` | 1 |  |  |
| `gift-amount-3` | `input` | 1 |  |  |
| `gift-amount-4` | `input` | 1 |  |  |
| `donation-button-classy` | `button` | 1 | Give now |  |
| `above-main-content-portal` | `div` | 1 | Turn learning into progress.Create a free ac |  |
| `close-button` | `button` | 1 | Close Sign Up Banner |  |
| `course-previous-nav` | `button` | 1 | Previous in course |  |
| `course-next-nav` | `button` | 1 | Next in course |  |
| `learnable-content-cells` | `ul` | 1 | Using place value to add 3-digit numbers: pa |  |
| `learnable-content-active` | `div` | 1 | Add within 1000 |  |
| `sidebar-close` | `button` | 1 | Close content list |  |
| `content-panel-wrapper` | `div` | 1 | Add within 1000FL.BEST.Math: MA.3.NSO.2.1Mic |  |
| `content-library-content-panel` | `div` | 1 | Add within 1000FL.BEST.Math: MA.3.NSO.2.1Mic |  |
| `content-library-content-title` | `h1` | 1 | Add within 1000 |  |
| `share-to-teams-button` | `button` | 1 | Microsoft Teams |  |
| `share-to-teams-button-start-icon` | `div` | 1 |  |  |
| `share-to-teams-button-inner-label` | `span` | 1 | Microsoft Teams |  |
| `share-to-teams-button-end-icon-wrapper` | `div` | 1 |  |  |
| `share-to-teams-button-end-icon` | `span` | 1 |  |  |
| `input-with-examples` | `input` | 1 | Your answer: | 是 |
| `drawing-area` | `div` | 1 |  |  |
| `content-library-footer` | `div` | 1 | Do 4 problemsSkipCheck |  |
| `toggle-drawing-area` | `button` | 1 | Draw on exercise |  |
| `start-over-button` | `button` | 1 | Start over |  |
| `exercise-progress-0-incomplete-current` | `div` | 1 | in progress |  |
| `exercise-progress-1-incomplete` | `div` | 1 | incomplete |  |
| `exercise-progress-2-incomplete` | `div` | 1 | incomplete |  |
| `exercise-progress-3-incomplete` | `div` | 1 | incomplete |  |
| `exercise-skip-button` | `button` | 1 | Skip |  |
| `exercise-check-answer` | `button` | 1 | Check |  |
| `exercise-check-answer-inner-label` | `span` | 1 | Check |  |

## 与计时直接相关的 testid

已在 `src/site-profile.ts` 中使用，并标注了各自的建立方式。

| testid | 用途 | 建立方式 |
|---|---|---|
| `exercise-progress-<索引>-<状态>[-current]` | 题目在练习中的**位置索引** → 题目标识 | 真实切题驱动，索引 0→1→2→3 |
| `input-with-examples` | 数值 / 表达式输入控件 | 真实输入 |
| `exercise-check-answer` | 提交答案按钮（同时用于记录第一次提交时间戳） | 真实提交 |
| `exercise-next-question` | 答对后出现的「下一题」按钮 | 真实切题 |
| `exercise-skip-button` | 跳过按钮（会弹确认框，**不**作为切题信号） | 真实点击 |
| `start-over-button` | 重做整套练习（实现中作为强制重题信号） | DOM 观察 |
| `content-library-footer` | 页脚容器，内含进度点与上述按钮 | DOM 观察 |
| `popover-close-btn` | 反馈浮层关闭按钮（佐证反馈位于题目区域之外） | 真实答题 |

## 稳定但非 testid 的选择器

| 选择器 | 用途 | 建立方式 |
|---|---|---|
| `form[name="answerform"]` | **题目区域**（首选） | 提交答案前后文本逐字节相同 |
| `.framework-perseus` | 题目区域（备选） | 同上 |
| `.perseus-renderer` | 题目区域（末选） / 题干来源 | 同上 |
| `.perseus-widget-container` | 答案控件容器 | DOM 观察 |
| `.perseus-input` | 输入类控件 | DOM 观察 |
| `[role="dialog"]` | 反馈 / 确认 / Cookie 浮层（均在题目区域之外） | 真实答题 + 真实跳过 |
| `[data-exercise-id]` | 整个练习的 id（`"2002"`），用于稳定练习键 | DOM 观察 |

## 确认**不存在**的信号

以下属性在练习页上各 0 次匹配：

`data-question-id` · `data-item-id` · `data-problem-id` · `data-perseus-id` · `data-question`

**结论：** Khan Academy 不为单题提供稳定 id，因此需求 2.4 中「优先使用可稳定取得的题目标识」
在本站点上无法满足，必须退到「进度索引 + 题干指纹」的组合方案。

## 明确要避免的脆弱选择器

| 脆弱选择器 | 为什么不用 |
|---|---|
| `_7zhre1`、`_xa8e8o1`、`_1qjiuz8w` 等 | Emotion / styled-components 生成的哈希类名，每次站点构建都会变 |
| `.css-1x2y3z` 形态 | 同上 |
| `div > div:nth-child(3) > span` 形态的位置链 | 站点插入一个包裹元素就会失效 |
| `[class*="..."]` 模糊匹配哈希 | 命中率不可控，且会随构建漂移 |

本项目**只**使用：语义化 HTML（`form[name="answerform"]`）、站点自有的稳定
`data-testid`、Perseus 的语义类名（`.perseus-renderer` 等）、以及标准 ARIA
（`[role="dialog"]`）。

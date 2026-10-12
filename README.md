# Khan Academy Timer — 开发者说明

给可汗学院（Khan Academy）练习题与测验做的**题目计时**扩展：自动识别当前题目并计时，
支持正计时 / 倒计时、暂停 / 继续 / 重置、页内悬浮面板，以及结束页的「本轮每题用时」卡片。
Manifest V3 + TypeScript + esbuild，在 **Chrome 与 Edge**（Chromium 114+）上加载，
数据只存本机。

> **本文件面向维护者。** 安装与使用说明在 **[用户指南（English / 简体中文）](docs/user-guide.md)**。
> *Looking to install it? See the **[User Guide](docs/user-guide.md)**.*

**两条硬约束**（改动时不得破坏，`scripts/verify-dist.mjs` 会逐条机器断言）：

1. **产物里没有任何网络代码**：`dist/*.js` 中出现 `fetch` / `XMLHttpRequest` / `WebSocket` /
   `EventSource` / `sendBeacon` / `eval` / `new Function` / `importScripts` / 远程脚本注入 /
   绝对 http(s) 地址，构建校验即失败。
2. **权限只有 `storage` + `activeTab`**，内容脚本只匹配 `khanacademy.org`；
   没有 `host_permissions`、没有 background worker、没有 `web_accessible_resources`。

---

## 目录

- [快速开始](#快速开始)
- [命令](#命令)
- [架构与不变量](#架构与不变量)
- [代码结构](#代码结构)
- [验证与 CI](#验证与-ci)
- [发布](#发布)
- [权限](#权限)
- [文档地图](#文档地图)
- [故障排查](#故障排查)

---

## 快速开始

需要 Node.js ≥ 20；包管理器 pnpm 的版本由 `package.json` 的 `packageManager` 固定
（`corepack enable` 后自动生效）。

```bash
pnpm install
pnpm run build      # 生成 dist/
pnpm run verify     # 离线全量校验：类型检查 + 单元测试 + 构建 + 产物检查
```

浏览器里调试：`chrome://extensions` 或 `edge://extensions` → 打开**开发者模式** →
**加载已解压的扩展** → 选 **`dist/`**。**浏览器只加载 `dist/`，`src/` 是源码。**

改了源码之后的三步：`pnpm run build` → 扩展页点卡片上的**重新加载**（↻）→ 刷新可汗学院页面。
浏览器不会自己感知 `dist/` 的变化。

---

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm run build` | esbuild 打包到 `dist/`（**刻意不压缩**，同时输出 source map，便于人工审查「没有数据上传」） |
| `pnpm run build:watch` | 监听源码变化自动重建 |
| `pnpm run typecheck` | `tsc --noEmit`（严格模式） |
| `pnpm run test` / `test:watch` | vitest（jsdom；`chrome.storage` 用内存替身） |
| `pnpm run verify` | typecheck + test + build + `verify-dist.mjs`，**完全离线**，可当提交门禁 |
| `pnpm run icons` | 从 `assets/logo.png` 重新生成 `public/icons/*.png`（只用 Node 内置 `zlib`，无图像依赖） |
| `pnpm run verify:edge` | 真实 Edge 端到端：加载 `dist/`，驱动线上练习页，读 Shadow DOM |
| `pnpm run verify:startcard` | 真实 Edge：练习起始页不闪面板 + 第 1 题无多余暂停用时 |
| `pnpm run verify:practice-switch` | 真实 Edge：练习 A → B → 回到 A 做完整轮（结束页卡片需登录，见脚本头注释） |

三个真实浏览器脚本按 `EDGE_PATH` → 平台默认安装位置 → `PATH`
的顺序定位浏览器，解析逻辑集中在 [`scripts/lib/browser.mjs`](scripts/lib/browser.mjs)；
非默认安装位置时：

```bash
EDGE_PATH="/path/to/msedge" pnpm run verify:edge
```

找不到浏览器时脚本会在启动任何进程**之前**报错并列出试过的路径。

---

## 架构与不变量

下面这些行为是在真实页面上实测得到、并被单元测试锁定的。**改识别、计时或存储前先读对应测试**，
否则很容易把已修好的缺陷改回来。每条的「为什么」都写在对应源码注释里，改选择器前请先按
[`AGENTS.md`](AGENTS.md) 自己抓一份真实 DOM。

| 不变量 | 说明 | 主要位置 |
|---|---|---|
| **题目标识 = 进度索引** | 身份取自 `exercise-progress-<索引>-<状态>` 的**索引**，不含状态段 —— 状态在每次提交答案时变化，算进去就会「一答题就换题」。站点不提供单题稳定 id。 | `question-detector.ts`、`site-profile.ts` |
| **身份升级不等于切题** | 加载时题目区域先出现（只有文本指纹）、进度标记后出现（约 20–190 ms）。这是**同一道题的身份升级**，必须保留引擎与会话，否则每题都会在 1 秒后从 0 重来。 | `question-detector.ts` |
| **计时从「页面报出第几题」开始** | 区域已渲染但没有位置时：不显示面板、不计时、不产生暂停用时。这条修掉了「第 1 题莫名多出 `暂停 0:01`」。 | `controller.ts` |
| **面板只在确实做题时出现** | 宿主 `#khan-academy-timer-host` 挂载时即 `display:none`，位置报出后才由渲染循环打开；起始卡片、课程页、视频页上都不显示，也不会闪一下。 | `overlay.ts`、`controller.ts` |
| **识别失败 = 暂停，不是重置** | 找不到题目区域或无身份信号时：隐藏面板 + **暂停**本题（引擎、累计用时、第一次提交时间戳、`runId` 全部保留），同一道题回来即从暂停处继续；**学生手动按的暂停不会被自动继续**。这段不计入用时，但本题仍出现在结束页统计里。 | `controller.ts`、`timer-engine.ts` |
| **停表条件** | 答对（状态 `correct`，或 Check 按钮被下一题控件取代 —— 因为进度标记只保留**第一次**作答的判定，答错后重答正确不会变状态）与确认 Skip 停表；答错、点 Cancel、选中选项、输入答案都不停表。 | `controller.ts` |
| **时间语义** | 用时全部由时间戳差分得出，不依赖定时器触发次数（后台标签页、休眠后恢复都正确）。关闭页面或离开练习期间**冻结**；`session:<练习路径>` 每个练习一份，TTL 12 小时，只按「练习 + 题目」都匹配才续接。 | `timer-engine.ts`、`storage.ts` |
| **单页应用换练习立刻作废旧身份** | 地址变化即作废识别状态：新练习的第一题即使进度一样也必须是新题，否则旧练习的读数会继续涨。 | `controller.ts` |
| **结束页取数三层** | `exerciseKey`（哪套题）→ `attempt:<练习路径>`（本次尝试窗口，只有真的看过结束页才推进）→ `runId`。卡片按**题号**排列，缺数据的题号保留并标「数据缺失」，不会把下一题的用时顶上来；加试题排在编号题之后。 | `summary-view.ts`、`storage.ts` |
| **记录写入串行** | `chrome.storage` 没有事务，「读出→追加→写回」并发会互相覆盖（结束页少一行）。所有写入串到一条队列，读方先 `flush()`。 | `storage.ts` |
| **i18n：`en.ts` 是键的真源** | `MessageKey` 由 `src/i18n/en.ts` 派生，其它语言是 `Record<MessageKey, string>`，**漏译编译不过**；`_locales/` 只放扩展名与描述。 | `src/i18n/`、[`docs/i18n.md`](docs/i18n.md) |
| **版本号只有一个来源** | `scripts/build.mjs` 把 `package.json` 的 `version` 写进 `dist/manifest.json`；manifest 只接受纯数字点号版本。 | `scripts/build.mjs` |

去抖与冷却的默认值（可在设置里覆盖，弹窗不暴露）：新身份需连续稳定
**400 ms**、且距上次已接受的切换 **≥ 1200 ms**；候选出现后会安排一次延后复核。

识别细节的设计依据（题目区域选择器、提示展开不重置计时、`Start over` 视为新题等）
以源码注释为准：`src/site-profile.ts` 里每条选择器都标了它是怎么确立的
（`[OBS]` 实采观察 / `[VER]` 真机驱动验证 / `[STD]` 平台标准钩子）。

---

## 代码结构

```text
src/
├── content.ts             # 内容脚本入口（无副作用，只启动协调器）
├── controller.ts          # 计时协调器：识别事件 → 计时 / 记录 / 会话 / 结束页
├── question-detector.ts   # 题目识别：纯决策逻辑 + DOM 适配器
├── site-profile.ts        # ★ 所有站点选择器与适配规则集中于此
├── timer-engine.ts        # 正计时/倒计时状态机（纯逻辑，时钟可注入）
├── storage.ts             # 设置、记录、进行中会话、写入队列
├── overlay.ts             # 页内悬浮面板（Shadow DOM）
├── summary-view.ts        # 结束页的「本轮每题用时」卡片（Shadow DOM）
├── popup.ts               # 扩展弹出面板逻辑
├── i18n/                  # 全部界面文案：en.ts 真源 + zh-CN.ts 译文 + t()/localizeDom()
├── sound.ts               # 超时提示音（Web Audio 现场合成，无音频文件）
├── types.ts / util.ts     # 共享类型 / 指纹哈希与通用工具
public/                    # manifest.json、popup.html/css、_locales/、icons/（构建时整体复制）
scripts/                   # build + 图标生成 + 四层验证脚本
scripts/capture/           # 真实站点抓 DOM / 脱敏（AI agent 与维护者用，见 AGENTS.md）
tests/                     # vitest（8 个文件）
docs/                      # 面向维护者与用户的说明文档
assets/logo.png            # 图标原图，pnpm run icons 由它生成 public/icons/
```

抓取到的 DOM 数据（原始抓取、脱敏摘录、截图）**刻意不进版本库**，一律落在
`.gitignore` 忽略的 `.tmp-caps/`：它们会随可汗学院改版立即过期，而一份看起来仍权威的
过期样本比没有样本更危险。需要时按 [`AGENTS.md`](AGENTS.md) 里的两条命令重新采集即可
（该路径可复现：实测相隔数天的两次采集字节完全一致）。采集得到的设计结论不单独存档，
而是直接写在源码注释里——`src/site-profile.ts` 每条选择器都标了来源等级，读代码即可看到
「为什么」。同理，**未验证的页面类型不单独维护清单**：扩展遇到不认识的页面会明确说
「未识别」并暂停计时，行为本身就是声明。

`site-profile.ts` 集中全部站点选择器与适配规则：站点改版时只改这一处，不要在选择器散落到
各模块；`dist/` 是纯构建产物，`.gitignore` 忽略。

---

## 验证与 CI

四层验证中的三层可以随时重跑：前两层完全离线，真实浏览器层需要本机 Edge 与网络，
手动步骤另见下。

| 层 | 命令 | 当前规模 | 覆盖 |
|---|---|---|---|
| 单元测试 | `pnpm run test` | **271 用例 / 8 文件** | 计时引擎、识别决策与 DOM 适配、协调器（jsdom 端到端，含切练习与结束页题号模型）、存储与写入队列、结束页行序模型、面板/弹窗、i18n |
| 产物检查 | `node scripts/verify-dist.mjs` | **61 项** | manifest 可解析且引用文件存在、权限允许清单、内容脚本匹配范围、`dist/*.js` 无网络/动态执行代码、图标尺寸、`_locales` 与 `__MSG_*` 可解析 |
| 真实浏览器 | `pnpm run verify:edge`、`verify:startcard`、`verify:practice-switch` | 端到端 | 把 `dist/` 作为解压扩展加载进真实 Edge，经 CDP 读面板 Shadow DOM 与 `chrome.storage.local` |

真实浏览器里难以稳定制造的场景（例如「识别失败 → 暂停 → 恢复」）已尽可能改写成 jsdom
端到端用例，见 `tests/controller.test.ts` 的 *pauses instead of resetting when the question
region disappears and comes back*；剩下的手动步骤在上面三条 `verify:*` 命令的输出里按提示操作。

工作流：

| 工作流 | 触发 | 内容 |
|---|---|---|
| [`verify.yml`](.github/workflows/verify.yml) | push / PR（+ 手动） | `pnpm run verify`，全离线，当提交门禁 |
| [`e2e.yml`](.github/workflows/e2e.yml) | 只手动 | 在 runner 上装 Edge，跑 `pnpm run verify:edge`（联网、驱动线上站点，不该拦住普通提交） |
| [`release.yml`](.github/workflows/release.yml) | 推 `v*` tag | 见下节 |

`verify:practice-switch` 不进任何工作流：它的结束页卡片验证需要真实登录账号。

---

## 发布

1. 改 `package.json` 的 `version` 并提交到 `main`；
2. `git tag v0.3.0 && git push origin v0.3.0`（tag 的版本号必须与 `package.json` 一致，
   必须指向 `main` 上的提交，否则 `release.yml` 直接失败、不发布任何东西）。

工作流跑 `pnpm run verify`，然后把 `dist/` 打成 ZIP：**归档根目录就是扩展本身**
（`manifest.json` 在顶层），所以同一个 ZIP 既能给用户解压后「加载已解压的扩展」，
也能直接上传商店。归档条目排序、不写额外属性、时间戳固定为被 tag 的提交时间，
因此**重建同一提交得到字节一致的 ZIP**；Release 里同时附 `SHA256SUMS.txt`，
谁都能自己复算。带后缀的 tag（`v0.3.0-rc.1`）发布为 pre-release。

---

## 权限

| 权限 | 用途 | 代码 |
|---|---|---|
| `storage` | 保存设置、计时记录、进行中的会话 | `src/storage.ts` |
| `activeTab` | 弹出面板读取当前标签页的实时计时状态 | `src/popup.ts` |

内容脚本只匹配 `https://www.khanacademy.org/*` 与 `https://*.khanacademy.org/*`。
**没有** `host_permissions`、`tabs`、`cookies`、`clipboardRead`、`geolocation`、
麦克风、摄像头，也没有任何「以后可能用到」的权限 —— `verify-dist.mjs` 把它当硬性检查。

---

## 文档地图

| 文档 | 读者 | 内容 |
|---|---|---|
| [`docs/user-guide.md`](docs/user-guide.md) | **用户** | 从 Release 下载 ZIP 并导入 Chrome / Edge、使用、设置、隐私、疑难解答（English 默认 + 简体中文） |
| [`docs/i18n.md`](docs/i18n.md) | 维护者 | 多语言方案、语言解析、**新增一种语言的步骤** |
| [`AGENTS.md`](AGENTS.md) | AI agent / 维护者 | 改选择器前必读：如何自己抓到真实 DOM，而不是反推 |
| 本文件 | 维护者 | 架构与不变量、验证与 CI、项目结构、权限、识别原理、故障排查 |

---

## 故障排查

**`pnpm run test` 报 Rollup 原生模块加载失败**（`Cannot find module @rollup/rollup-<platform>`、
`ERR_DLOPEN_FAILED ... different Team IDs`）：`pnpm-workspace.yaml` 已把 `rollup` 覆盖为纯
WebAssembly 版本（`@rollup/wasm-node`），默认不会出现；若装回了原生版本，
`rm -rf node_modules pnpm-lock.yaml && pnpm install`。

**构建后浏览器里没变化**：浏览器不会自动感知 `dist/`。扩展页点**重新加载**（↻）再刷新页面。

**真实浏览器脚本报找不到浏览器**：看 `EDGE_PATH`，或脚本报错里列出的候选路径；
`verify:edge` 需要网络并会驱动线上可汗学院。

**改了 `package.json` 的版本号但 manifest 没变**：manifest 由 `build.mjs` 在构建时同步，
重新 `pnpm run build` 即可，不要手改 `public/manifest.json` 的 `version`。

**面板读数或记录不符合预期**：先打开弹窗的**开发者模式**看诊断（命中的选择器策略、
置信度、题目指纹、最近事件）；页面上还可以直接读

```js
JSON.parse(document.getElementById('khan-academy-timer-host')
  .getAttribute('data-khan-timer-diagnostics'))
```

其中 `unidentified: true` 表示此刻确实读不出题目。

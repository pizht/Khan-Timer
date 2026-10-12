# 手动验证步骤（真实浏览器）

有些场景在无人值守的端到端脚本里无法稳定制造，只能在真实浏览器里手动走一遍。
本文件收集这些步骤；自动化能覆盖的部分见 [`README.md` → 验证与 CI](../README.md#验证与-ci)。

| 场景 | 为什么不能自动化 |
|---|---|
| 「识别：未识别 → 暂停 → 恢复」 | 浏览器里无法可靠地制造「练习题区域消失、进度标记不动、随后同一道题原样回来」这一幕 |
| 「练习起始页不会闪面板」的逐帧确认 | 已由 `pnpm run verify:startcard` 采样验证；本文件保留人工复核方式 |

被测页面：任意已验证的练习页（例如
`https://www.khanacademy.org/math/cc-third-grade-math/imp-addition-and-subtraction/imp-adding-with-regrouping-within-1000/e/addition_4`），
扩展由 `dist/` 以「加载已解压的扩展」方式加载。

---

## 1. 识别：未识别 → 暂停 → 恢复

在练习页（先让面板出现并计时几秒）打开 DevTools Console：

```js
// 1) 观察当前状态：unidentified=false，autoPausedForIdentity=false，enginePhase="running"
const host = document.getElementById('khan-academy-timer-host');
const read = () => JSON.parse(host.getAttribute('data-khan-timer-diagnostics'));
console.table(read());

// 2) 记住并移除题目区域（把三种候选选择器都移除，模拟「页面读不出题目」）
const removed = [...document.querySelectorAll(
  'form[name="answerform"], .framework-perseus, .perseus-renderer',
)].map((el) => [el.parentNode, el, el.nextSibling]);
removed.forEach(([, el]) => el.remove());
// 约 0.7 s 后面板消失（弹出面板同时显示「未识别到题目：本题计时已暂停，
// 重新识别到本题后自动继续」）：
//   read() → { unidentified: true, autoPausedForIdentity: true, enginePhase: "paused" }
await new Promise((r) => setTimeout(r, 5000));   // 这 5 秒不应计入本题

// 3) 把同一个题目区域原样放回（还是同一道题，进度标记一动没动）
removed.reverse().forEach(([parent, el, next]) => parent.insertBefore(el, next));
// 面板立即（毫秒级）重新出现：
//   read() → { unidentified: false, autoPausedForIdentity: false, enginePhase: "running" }
// 面板读数从暂停时的数值继续，而不是从 0:00 重新开始
```

做完这一轮练习并进入结束页后，「本轮每题用时」里**仍然有这道题的那一行**，
用时不含第 2 步等待的 5 秒；如果暂停超过 1 秒，那一行还会多出一行小字 `暂停 0:05`。

> 同样的字段（`unidentified` / `autoPausedForIdentity` / `enginePhase`）由
> `tests/controller.test.ts` 自动断言（`a question that cannot be identified` 四条），
> 其中 `matches the manual verification recipe in docs/manual-verification.md (remove then restore the region)`
> 就是上面这段操作的逐步复现，所以手动步骤与单元测试检查的是同一件事。
>
> 「识别失败时暂停而不是重置」的设计理由与完整行为见
> [`known-limitations.md`](known-limitations.md) 与
> [`research/observations.md`](research/observations.md)。

---

## 2. 练习起始页不会闪面板

在练习之间来回切几次，或直接打开一个练习链接（`…/e/<slug>`），确认：

1. **起始页（`Ready to practice?` / 「Let's go」）上自始至终没有面板** —— 尤其注意
   页面刚打开的那一瞬间，不应该先闪出一个小面板再消失。DevTools Console 里可以逐帧看：

   ```js
   // 起始页上应当一直是 none（面板宿主挂载时就是隐藏的）
   const host = document.getElementById('khan-academy-timer-host');
   setInterval(() => console.log(host.style.display || '(visible)'), 100);
   ```

2. **点 `Let's go`、题目出现后**，面板立刻出现并开始计时（题目区域先出现、位置稍后
   报出的 20–190 ms 内不计时也不显示面板；第 1 题的读数里不会混进起始页或加载的时间，
   也就不会再出现莫名的「暂停 0:01」）。
3. **从另一个练习切过来**（应用内路由切换）时，起始页上不会出现上一个练习的读数。
4. **第 1 题不再带「暂停 0:0x」**：答对第 1 题后前进到第 2 题，打开弹出面板应看到
   记录里 `暂停用时` 为空（`pausedMs: 0`）、用时就是真正做题的时间。

> 这四条对应 `tests/controller.test.ts` 的「the panel appears only over a question being
> solved」与「a question region that carries no position yet」；真机上可以直接跑
> `pnpm run verify:startcard`（10 项，含答完第 1 题后读记录）。背景见
> [`known-limitations.md`](known-limitations.md) 第 30、31 条。

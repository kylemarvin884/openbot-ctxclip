# ctxclip

**工具输出进 context 之前先压缩：规则确定性、不调模型，每一段省略都有计数和回读路径。**

一份 1,712 行、72 kB 的失败测试日志（去掉 ANSI 后 67.8 kB），压到 174 行 / 7.1 kB（-89.5%），
4 个失败用例的错误行、断言差异和堆栈一条不少，被折叠的 1,567 行全部有标记和原文路径。

```bash
$ ctxclip filter demo/sample.log
> ctxclip-demo@0.1.0 test
> vitest run --reporter=verbose

 ✓ src/unit/file-0.test.ts (12 tests) 900ms
   ✓ handles payload 0 (1 ms)
… [ctxclip] 10 lines omitted (10 progress)
   ✓ handles payload 11 (12 ms)
   ... 0% done [....................] 0ms
 ✓ src/unit/file-1.test.ts (12 tests) 937ms
   ✓ handles payload 0 (1 ms)
… [ctxclip] 10 lines omitted (10 progress)
   ✓ handles payload 11 (12 ms)

   × rejects expired token (round 5)
     → expected 401, received 200
     at src/checkout/session.test.ts:105:14
       at validateSession (src/auth/session.ts:88:11)
       at Object.<anonymous> (src/checkout/session.test.ts:105:5)
       at validateSession (src/auth/session.ts:88:11)
       at Object.<anonymous> (src/checkout/session.test.ts:105:5)
       at validateSession (src/auth/session.ts:88:11)
       at Object.<anonymous> (src/checkout/session.test.ts:105:5)
   ... 5% done [###############.....] 185ms

… [ctxclip] 67 lines omitted (50 progress, 9 budget, 8 other) — full text: demo/sample.log
   × rejects expired token (round 16)
… [ctxclip] 154 lines omitted (110 progress, 22 budget, 22 other) — full text: demo/sample.log
   × rejects expired token (round 27)
```

中间省略的 1,000 多行里，898 行是编译进度、199 行是同一句 npm warn，其余是通过的用例。
结尾 19 行原样保留：

```text
[00:00] compiling module 0/900 ... ok
… [ctxclip] 898 lines omitted (898 progress) — full text: demo/sample.log
[14:59] compiling module 899/900 ... ok

npm warn deprecated inflight@1.0.6: This module is not supported
… [ctxclip] 199 lines omitted (199 duplicate) — full text: demo/sample.log

 FAIL  src/checkout/session.test.ts > session validation
  × every failure above is kept, not truncated away

 Test Files  4 failed | 36 passed (40)
      Tests  4 failed | 476 passed (480)
   Start at  10:04:12
   Duration  18.42s (transform 3.11s, setup 0ms)

error Command failed with exit code 1.

ctxclip: demo/sample.log 67.8 kB → 7.1 kB (89.5% smaller) | 1,712 → 174 lines | signals kept 42/241 | dropped 1,567 accounted
```

上面这段是本仓库 `npm run demo` 生成日志的真实输出，不是示意图。demo 会自检：
4 条唯一失败行是否全在、省略行数是否和原始行数对得上、是否超出字符预算。

## 为什么

coding agent 的上下文里，最大的一类噪音是命令输出：测试日志、构建日志、整文件读取。
现在的处理方式都有缺口：

- **harness 静默截断**（首尾各留一段，中间丢掉）：模型只看到「truncated」，
  不知道丢了什么、丢了多少、去哪拿原文，于是基于半份日志下结论，或者干脆重跑一遍。
- **让模型自己摘要**：多一次调用、多一份成本、不可复现，摘要本身还可能吞掉错误行。

ctxclip 的做法是：在输出进入 context **之前**，用固定规则压缩，并把每一次丢弃
写进输出本身。

## 安装

需要 Node >= 22，零依赖，不联网，不调模型。

```bash
git clone https://github.com/kylemarvin884/openbot-ctxclip
cd openbot-ctxclip

node src/cli.mjs --help          # 直接跑
npm link                         # 或者装成全局命令 ctxclip
```

本地 demo（会生成 `demo/sample.log`，可重复）：

```bash
npm run demo     # 打印压缩前后对比 + 自检
npm test         # 43 个测试，全部离线
```

## 用法

一条命令包住任意命令，退出码原样透传：

```bash
ctxclip run -- npm test
```

处理已有日志或管道（不执行任何东西）：

```bash
ctxclip filter build.log
cat huge.log | ctxclip filter -
```

常用参数：

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--max-chars=N` | 8000 | 输出字符预算，超了就按阶梯收紧 |
| `--keep-head=N` / `--keep-tail=N` | 12 / 12 | 首尾各保留多少行 |
| `--signal-max=N` | 60 | 最多保留多少条 error / 堆栈行 |
| `--spill-dir=DIR` | `./.ctxclip/<时间>` | 完整输出的落盘位置 |
| `--no-spill` | 关 | 不落盘（标记里也不会给路径） |
| `--report=FILE` | 关 | 写机器可读的 JSON 统计 |
| `--timeout=MS` | 不限制 | 子进程超时（`run`） |

`run` 的真实回执（stderr）：

```text
ctxclip: stdout 5.9 kB → 1.3 kB (78.6% smaller) | 121 → 25 lines | signals kept 1/1 | dropped 97 accounted | exit 1 | 334ms
```

完整 stdout 留在 `.ctxclip/2026-10-31_02-12-52/stdout.log`，标记里给的就是这个相对路径。

## 规则（全部确定性）

| 规则 | 判定 | 处理 |
| --- | --- | --- |
| R1 归一化 | ANSI 颜色 / OSC 超链接 / CRLF | 删除转义，不动可见文字 |
| R2 连续重复 | 相邻行完全相同 | 保留 1 行 + 计数 |
| R3 进度抖动 | 数字归一化后同形、连续 ≥3 行、非信号行 | 保留首尾 + 计数 |
| R4 信号行 | error / fail / exception / 堆栈位置 / 断言差异 / `file:line` | 优先保留，超出 `--signal-max` 才折叠 |
| R5 首尾窗口 | 默认各 12 行 | 保留 |
| R6 字符预算 | 超过 `--max-chars` | 依次收紧首尾窗口 → 稀疏化中间锚点 → 收紧信号上限 → 裁剪超长单行 |

两条容易被忽略的保护：

- **标记不划算就不写标记**。一段只省略 1–2 行，或者省略掉的字符比标记本身还少，
  就直接保留原行。避免出现「标记比内容还多」的输出。
- **重复行不占信号额度**。200 行一模一样的 warning 折叠成 1 行 + 计数，
  不会把后面 5 条真正不同的 error 挤出 `--signal-max`。

## 不做什么

- 不做语义摘要、不调模型、不做向量压缩。输出只由输入和参数决定。
- 不接管 harness。它是 CLI + 一个纯函数，任何能跑命令的地方都能用。
- 不估算美元。token 数是 `字符数 / 4` 的 **estimate**，在 JSON 里明确标注。
- 不假装完整。单条超长行会被裁剪，并写明被裁掉多少字符；单流捕获上限 8 MB，
  超出时回执会说明。

## 三个真实用例

1. **无人值守的测试修复循环**：`ctxclip run -- npm test`，agent 只看到失败相关行，
   退出码仍是测试的退出码，需要细节时按标记里的路径去读原文。
2. **把日志贴进对话**：`ctxclip filter app.log --max-chars=4000`，
   比手动 `tail -100` 更不容易漏掉中间的异常。
3. **CI artifact 瘦身**：`--report=stats.json` 记录压缩率与丢弃明细，
   和 truncgap 一起用可以对照「压缩前丢了多少、压缩后丢了多少」。

## 作为库使用

```js
import { condense } from "openbot-ctxclip";

const { text, stats } = condense(rawOutput, {
  maxChars: 6000,
  label: ".ctxclip/stdout.log",
});

console.log(stats.reductionPercent, stats.signals, stats.dropped);
```

`condense()` 是纯函数：同样的输入和参数永远得到同样的输出，方便写进快照测试。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 正常（`filter`）或子进程成功（`run`） |
| 子进程原码 | `run` 原样透传，CI 里可以直接用 |
| `124` | `run` 超时被终止 |
| `2` | 用法错误 |

## 与同类工具的区别

2026-10-31 检索到的相关工具及其定位：

| 工具 | 形态 | 与 ctxclip 的区别 |
| --- | --- | --- |
| `billion-context`（npm） | harness 插件 | 绑定具体 harness，在会话层压缩 |
| `@tarquinen/opencode-dcp`（npm） | OpenCode 插件 | 只服务 OpenCode，剪掉的输出不保留回读路径 |
| harness 内置截断 | 内置 | 静默丢中间，不优先保留错误行 |
| `head` / `tail` / `grep` | 系统工具 | 需要先知道要找什么；agent 通常不知道 |

ctxclip 的取舍是：**与 harness 无关、零模型、丢弃可回读**。代价是它不会「理解」日志，
只按固定规则判断什么值得留。规则做不好的地方会漏掉重要但不含关键词的行——
这是已知边界，见下面的放弃条件。

## 已知边界

- `ctxclip run` 用本机 shell 执行你给的命令，**不做沙箱、不做权限判断**。它只负责压缩输出，
  能不能跑这条命令仍然是你（或你的 harness 权限配置）的责任。
- 中文日志里没有 `error` / 堆栈位置的行不会被当作信号，只会按首尾窗口保留。
- 单行超长 JSON（例如一整个 API response）会被裁剪，而不是结构化展开。
- 默认规则对「每个用例都打印一行 ✓」的测试框架收益最大；对几乎没有重复的日志收益有限。
- 预算收紧时被丢掉的锚点行在标记里记为 `budget`，不是「不重要」，而是「预算不够」。
- 如果压缩率中位数低于 40%，这个工具就不值得用——这条写在这里，也写进了选题 memo。

## License

MIT

# 0001 抽屉化与判断直推（drawer & agent routing）

范围来源：用户已确认的两个功能（A 抽屉化、B 判断直推），不含其他。本文为实现规格；Implementation Decisions 只写决定与理由，不写具体文件路径与代码片段。

## Problem Statement

- 笔记展示会吃掉整个屏幕。现在 widget 把最多 5 条笔记各渲染一整行、不截断；长笔记在窄终端里换行后，多条积压时笔记区不断变高。用户实际抱怨是「一直往上涨填满整个画面」——笔记是用来提醒的，却把正在工作的编辑区挤没了，用户被迫先去清笔记才能继续干活。
- 判定结果里最有行动价值的观察只能躺进抽屉等人来看。侧 agent 每隔几步会对会话做一次判定，指出「用户大概率没注意到、但有后果」的点；但判定结果目前只有「给人看」一种去处。主 agent 正在跑的时候它不会被及时告知；人不在键盘前时，一个本可当场修正的错误就这样滑过去，事后才知道。
- 判定结果没有表达「要不要现在告诉主 agent」的语言。即使判定方知道这条观察事关当前任务的正确性，也没有任何字段让它说「现在就提醒主 agent」或「不急，记下来就行」。

## Solution

两个改动，彼此独立：

- 抽屉化（A）。笔记区恒定只占 1 行：最新一条笔记截断成单行显示，行尾用 `+N` 计数其余积压的笔记，无论积压几条、笔记多长都不换行、不长高。想看全部笔记时走已有菜单通道展开（`/ysk` 或 alt+shift+y），菜单里列出全部待处理笔记，点开哪条就对哪条执行既有动作（Learn more / Knew / Chat / Dismiss）。`/ysk on|off|status|test`、`/ysk answer <id> <action>`、alt+x 的既有行为保持不变。
- 判断直推（B）。判定结果新增两个字段：`act`（一句给主 agent 的祈使句；`none` 表示只给人看）与 `urgency`（`now` | `later`）。路由完全由这两个字段决定，代码里不设任何「忙/闲」策略：
  - `act: none` → 只进抽屉（人可见通道，沿用现状）；
  - `act` 非 `none` 且 `urgency: now` → 用 `pi.sendMessage` 带 `deliverAs: "steer"` 塞进正在跑的轮次；
  - `act` 非 `none` 且 `urgency: later` → 只落盘不唤醒（持久化进会话记录，不惊动主 agent）。
  - 硬性护栏：发送前先把 `line` 写进 `state.seen` 去重；每次 run 最多 2 条直推；注入文本开头固定声明「这是侧 agent 的观察，先验证再改，判断错就直接说错」。

## User Stories

1. 作为 TUI 里的用户，我想要笔记区无论积压几条都恒定只占一行，以便我的屏幕不再被「一直往上涨」的笔记区填满。
2. 作为 TUI 里的用户，我想要那一行显示最新一条笔记（tag + 内容）并截断到当前宽度、绝不换行，以便一眼看到最新提醒而不挤占编辑区。
3. 作为 TUI 里的用户，我想要行尾用 `+N` 告诉我还有多少条没处理，以便知道积压数量而不用逐条翻。
4. 作为 TUI 里的用户，我想要只有一条笔记时不显示多余的计数噪声，以便画面干净。
5. 作为 TUI 里的用户，我想要通过已有菜单通道（`/ysk`、alt+shift+y）展开查看全部笔记，以便不学任何新快捷键就能找到被折叠的旧笔记。
6. 作为 TUI 里的用户，我想要展开后点开哪条就对哪条执行动作（Learn more / Knew this already / Chat in main session / Dismiss），以便处理我真正关心的那条，而不是被迫按固定顺序。
7. 作为 TUI 里的用户，我想要只有一条待处理笔记时 `/ysk` 直接进入动作菜单（不弹多余的列表），以便保持我习惯的快捷流程。
8. 作为 TUI 里的用户，我想要 alt+x 一键关掉顶部显示的那条笔记、不弹菜单，以便快速清掉我不关心的提醒。
9. 作为 TUI 里的用户，我想要 `/ysk on|off|status|test` 的行为完全不变，以便我的肌肉记忆和脚本继续可用。
10. 作为 RPC 客户端（如 T3 Code）用户，我想要 `/ysk answer <id> <action>`（含 `undo`）的行为完全不变，以便我的客户端集成不被破坏。
11. 作为用户，我想要笔记的积压上限、忽略计数与检查退避行为保持现状，以便检查频率的手感不因本次改动而变化。
12. 作为用户，我想要会话重启后笔记与答案状态照常恢复，以便抽屉化不影响持久化。
13. 作为用户，我想要侧 agent 的判定能带一句给主 agent 的行动指令（`act`），以便关键观察直接变成主 agent 的动作，而不是只躺在抽屉里等我看见。
14. 作为用户，我想要 `act: none` 的判定只进抽屉给我看，以便纯科普类观察不打扰主 agent。
15. 作为用户，我想要 `act` 非 `none` 且 `urgency: now` 的判定立即以 `deliverAs: "steer"` 塞进正在跑的轮次，以便主 agent 在当前任务里就来得及修正。
16. 作为用户，我想要 `act` 非 `none` 且 `urgency: later` 的判定只落盘不唤醒，以便它进入会话记录供下次参考而不打断正在进行的工作。
17. 作为主 agent，我想要注入文本开头固定声明「这是侧 agent 的观察，先验证再改，判断错就直接说错」，以便我知道先核验再动手、错了就明说。
18. 作为用户，我想要路由完全由 `act`/`urgency` 决定、代码不读取任何忙/闲状态，以便行为可预测、可测试。
19. 作为用户，我想要发送前先把 `line` 写进 `state.seen` 去重，以便同一条观察绝不重复打扰我和主 agent。
20. 作为用户，我想要每次 run 最多 2 条直推，以便再糟糕的判定也不会刷屏打断我。
21. 作为用户，我想要超过上限的直推被丢弃并记进检查日志，以便事后可审计而不是静默丢失。
22. 作为用户，我想要 `act`/`urgency` 排在 `explain` 之前被解析，以便「`explain` 吞掉其后所有行」的既有语义不破坏新字段。
23. 作为用户，我想要 `urgency` 缺失或非法时保守地按 `later` 处理，以便解析异常绝不误唤醒主 agent。
24. 作为用户，我想要 `learn: none` 时判定输出保持单行不变，以便默认安静、不因新字段变啰嗦。
25. 作为 RPC 客户端用户，我想要直推消息在我的会话记录里可见（带声明头与 `act` 内容），以便审计主 agent 被注入了什么。
26. 作为主 agent，我想要直推文本里附上 `learn` 行与 `evidence` 作为依据，以便我核验时知道它在说什么、出处在哪。
27. 作为维护者，我想要新增的解析、路由、截断与文本拼装都是可注入依赖的纯函数，以便测试不需要 mock 整个 TUI。
28. 作为用户，我想要 herdr 子 agent 的 relay 行为保持现状，以便父子协作不因本次改动回归。
29. 作为用户，我想要直推路径不再额外 fork 生成 `explain`，以便新能力不带来额外成本。
30. 作为用户，我想要被直推的判定**同时**留在抽屉里（1 行），以便我看得到侧 agent 对主 agent 说了什么，随时可以叫停或纠正。

## Implementation Decisions

已知约束（与决定同等效力）：

- `explain:` 字段会吞掉其后所有行，因此 `act`/`urgency` 必须排在 `explain` 之前。
- 仓库当前测试风格是「真实 pi 进程 + 本地 HTTP fixture 服务器」，观测面是 checks.jsonl / RPC 事件 / session 文件，不是 mock。
- 新增纯函数要有可注入依赖的接缝，避免为了测试去 mock 整个 TUI。

抽屉化（A）：

- widget 容器恒定渲染一个文本行：不再按笔记条数逐行堆叠。单行内容为最新一条笔记的 `tag`、来源标注（如有）与 `line`，按渲染宽度截断并带省略标记，绝不换行。
- 行尾追加 `+N` 计数未显示的其余待处理笔记；`N` 为 0 时不显示计数；无待处理笔记时卸载 widget（与现状一致）。
- 笔记队列的生命周期语义全部不变：到达顺序、积压上限（最多 5 条、溢出丢最旧）、忽略计数与检查退避、会话内持久化与恢复。本次只改渲染。
- 展开查看全部笔记走已有菜单通道：`/ysk` 与 alt+shift+y 共用的 select 菜单。待处理多于一条时，菜单先列出全部笔记（最新在前，抽屉显示的那条即首项），点开哪条就对哪条执行既有动作菜单；只有一条时直接进入动作菜单（与现状一致）。
- 动作菜单内容不变（`1 Learn more`、`2 Knew this already`、`3 Chat in main session`、`0 Dismiss`）及其后的行为（fork 生成 explain、写入 known、引用进主会话、移除笔记）。
- 明确保持不变：`/ysk on|off|status|test`、`/ysk answer <id> <action>`（含 `undo`）、alt+x 单键快速关闭且不弹菜单。
- alt+x 关闭的对象是抽屉当前显示的那条（即列表首项）：契约「一键关掉顶部那条笔记」不变，只是「顶部」随抽屉显示顺序（最新在前）定义。若维持旧行为（关最旧那条）会造成按 alt+x 屏幕上可见行毫无变化、只有计数跳动的怪异反馈，故作此决定。

判断直推（B）：

- 判定输出结构新增两个按行前缀解析的字段：`act:` 与 `urgency:`，与 `learn:`、`tag:`、`evidence:` 同级。
- `act` 取值：`none`（只给人看）或一句给主 agent 的祈使句。`urgency` 取值：`now` 或 `later`。
- 字段顺序定为 `learn` / `tag` / `evidence` / `act` / `urgency` / `explain`。解析器只在 `explain` 之前寻找 `act`/`urgency`；`explain` 之后的行（含其中出现的 `act:`、`urgency:` 字样）一律属于解释正文，不得误读。
- `learn: none` 时输出保持单行（无 `tag`/`evidence`/`act`/`urgency`/`explain`），与现状一致。
- 路由表（同一判定只走一条路由）：
  - `act` 为 `none`（含缺失）→ 人可见通道：TUI 抽屉 / RPC notify，沿用现状。
  - `act` 非 `none` 且 `urgency: now` → `pi.sendMessage` 带 `deliverAs: "steer"`，塞进正在跑的轮次。
  - `act` 非 `none` 且 `urgency: later` → `pi.sendMessage` 持久化投递（不带 `deliverAs`，写进会话记录、不唤醒），与既有空闲投递路径同款语义。
  - `act` 非 `none` 且 `urgency: now` / `later` → **人的通道不变**：照旧进抽屉、照旧发 notify（与改动前一致），直推只是在其之上多投一条消息给主 agent。两个通道正交，互不抑制。
  - 直推不额外生成 `explain`（人看不到正文，省成本）；`explain` 仍按需在 `1 Learn more` 时生成。
- 路由完全由 `act`/`urgency` 决定：不读取任何忙/闲状态（不做 `isIdle` 之类的分支），包括 `urgency: now` 时也照发，由投递机制自行排队。既有 herdr relay 的忙/闲分支保持原样，不属于本决定管辖。
- 异常取值降级：`act` 非 `none` 而 `urgency` 缺失或非法 → 保守按 `later` 处理并记日志（宁可不唤醒，不可误唤醒）；`act` 缺失 → 视为 `none`。
- 护栏一（去重先行）：发送前先把 `line` 写进 `state.seen`，随后才调用发送。发送失败也不回滚 `state.seen`（宁可漏发，不许重发）。被直推的判定同样先经过既有 dedup（对照 `state.seen` 与 known）与 stale 检查。
- 护栏二（每 run 限量）：每次 run 最多 2 条直推（`steer` 与落盘合计）。run 定义为一次 agent run（由一次用户提示或注入触发，到 Pi 无剩余自动工作为止）。run 开始时计数归零；只统计真正发出的直推；达到上限后的 `act` 判定直接丢弃并记日志（不降级进抽屉、不排队补发）。
- 注入文本结构：以固定声明开头（原文：这是侧 agent 的观察，先验证再改，判断错就直接说错），换行后是 `act` 句，再附 `learn` 行与 `evidence` 作为依据。`steer` 与落盘两种投递共用同一文本。
- 直推消息以 custom message 形式进入会话（沿用现有 customType），details 携带 `act`/`urgency`/`line`/`evidence` 与去重标识，便于在 session 记录中审计与断言。
- 判定提示词模板同步扩展：给出 `act`/`urgency` 的语义、取值与位置约束（必须排在 `explain` 之前），并明确 `act` 的高门槛（多数判定应为 `none`；`urgency: now` 只用于真正影响当前任务正确性的观察）。
- herdr 子 agent 路径本轮不变：子 agent 的判定仍走既有 relay 通道交给父 agent，`act`/`urgency` 随 relay 透传但不在子进程内直推。
- 被直推的判定**照旧进入笔记队列**：抽屉显示、alt+x 关闭、动作菜单、忽略计数与退避、会话内持久化，全部与普通笔记一致。直推不改变人的通道，只在队列之外多一条投递。检查节奏（每 6 个 turn 检查一次）不变。

## Testing Decisions

- 好测试的定义：只断言外部可观察行为——checks.jsonl 里的 outcome 与字段、RPC 事件流（notify、custom message）、session 文件内容、state.json 的 `seen`/`known`——不断言内部函数调用顺序，不截图、不断言 TUI 渲染细节。
- 测试风格约束（沿用仓库现状）：真实 pi 进程 + 本地 HTTP fixture 服务器，观测面是 checks.jsonl / RPC 事件 / session 文件，不是 mock。
- 新增测试接缝（纯函数，依赖注入，不 mock 整个 TUI）：
  1. 判定输出解析：判定文本 → 结构化字段（`learn`/`tag`/`evidence`/`act`/`urgency`/`explain`）。单测覆盖字段顺序、`explain` 吞行、`act`/`urgency` 出现在 `explain` 之后不被误读、`learn: none` 单行、非法 `urgency` 降级。
  2. 路由决策：(`act`, `urgency`, 本 run 已发计数) → 路由（抽屉 / steer / 落盘 / 丢弃）与「是否先写 `state.seen`」。发送器与状态写入由调用方注入，单测不触网、不起进程。
  3. 抽屉行文本：（笔记数组，宽度）→ 恒定单行字符串。单测覆盖：输出无换行、超宽截断带省略标记、`+N` 计数正确、单条不显示计数。
  4. 注入文本拼装：（`act` 句，`learn` 行，`evidence`）→ 带固定声明头的文本。单测断言声明头原文与顺序。
- 需要测试的模块：判定输出解析与路由（新，上述接缝 1、2）、抽屉单行渲染输入（新，接缝 3）、注入文本（新，接缝 4）、护栏（`state.seen` 先写、每 run 上限）以及既有行为回归（命令、`/ysk answer`、alt+x、退避、持久化）。
- Prior art（仓库里可照抄）：
  - tests/detection.test.mjs —— 真实 pi + 本地协议 fixture 服务器返回 detect 输出文本，经 checks.jsonl 断言 outcome，覆盖「空闲完成」等时序。直推路由端到端照抄它：fixture 分别返回 `act: none`、`act`+`urgency: now`、`act`+`urgency: later` 三种判定文本，断言各自的落点。
  - tests/rpc.test.mjs —— 真实 pi `--mode rpc` 的 JSON 事件流断言（notify、事件、session 文件），照抄它断言 steer 注入出现在会话记录、以及 `/ysk answer <id> <action>` 行为不变。
  - tests/routing.test.mjs —— wire request 与 checks.jsonl 断言，照抄它做护栏断言（每 run 上限、`state.seen` 先写后发）。
  - tests/notes.test.mjs —— 用 node:module registerHooks 把 TUI 依赖桩掉、直接调用扩展处理器的轻量接缝，照抄它做纯函数与状态写入的单测（这正是「不 mock 整个 TUI」的既有范例）。
- 行为级验收清单：
  1. 任意笔记条数与长度下，抽屉文本恒为 1 行（纯函数输出不含换行）。
  2. `+N` 计数正确；只有一条时无计数后缀。
  3. 展开菜单列出全部待处理笔记，点开哪条就处理哪条；单条时直达动作菜单。
  4. `act: none` → 只出现在人可见通道（抽屉 / notify），无 custom message 注入。
  5. `act` + `urgency: now` → 会话记录 / RPC 事件出现 `deliverAs: "steer"` 的注入，文本以固定声明开头。
  6. `act` + `urgency: later` → 消息落盘可见，但无唤醒（不触发新 run）。
  7. 同一 `line` 的第二次判定被 dedup（checks.jsonl outcome 为 deduped，且不再发送）。
  8. 发送中断/失败后重跑不重复发送（`state.seen` 先写可观察）。
  9. 每 run 第 3 条直推被丢弃并在 checks.jsonl 留下记录。
  10. `act`/`urgency` 若出现在 `explain` 之后，解析器不得把它们误读为字段（依赖 `(ei === -1 || i < ei)` 保护）；其原文会残留在解释正文中。这是容忍性要求，提示词仍规定 `act`/`urgency` 必须排在 `explain` 之前。
  11. 回归：现有四个测试文件全绿（`node --test tests/*.test.mjs`），`/ysk on|off|status|test`、`/ysk answer <id> <action>`、alt+x 的既有断言保持通过。
  12. 通道一致性：`act` 非 `none` 的判定**同时**出现在抽屉（恒 1 行）与会话注入里（`checks.jsonl` 与 session 记录都能看到），两个通道都不得缺失。

## Out of Scope

- btw 侧聊（本轮不做）。
- 改上游 README。
- herdr 子 agent relay 的直推化改造（子 agent 仍走既有 relay 通道）。
- 任何忙/闲策略（判断直推明确不做；既有 relay 的忙/闲分支保持原样）。
- 笔记积压上限、检查频率（每 6 turn）与忽略退避参数的调整。
- widget 的动画、滚动或行内展开交互（展开只走既有菜单通道）。
- 与上游 Claude Code mod 的字段对齐或同步。

## 与初版的偏离及理由

本节记录规格定稿后、实现开工前被推翻的条款。读到上文旧表述时以本节为准。

1. **被直推的判定是否同时进抽屉**：初版写「不进人可见通道（不进抽屉、不发 notify）」与「不进入笔记队列」，User Story 30 写「不再同时进抽屉」。改为：**照旧进抽屉、照旧在队列里**。理由有两条。其一是直推只解决「主 agent 不知道」，不解决「人不知道」；把人的通道关掉，人就看不到侧 agent 对主 agent 说了什么，失去审计与叫停能力。其二是抽屉已改为恒定 1 行，显示成本不再随条数增长。另外初版两句自相矛盾：不进队列就无法进抽屉。
2. **notify 是否抑制**：随第 1 条一并取消抑制，notify 行为与改动前保持一致。
3. **验收第 10 条的表述**：初版写「出现在 `explain` 之后不影响解析」。该保护只能保证不被误读成字段，无法保证 `act:` 那行文字不残留在解释正文里给用户看到。已改为容忍性要求，并写明残留现象。

共同前提：人的通道与 agent 的通道是两个正交的轴。本次只在后一个轴上增加投递，不削减前一个轴。


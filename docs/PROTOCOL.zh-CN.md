# 协议

[English](PROTOCOL.md) · **简体中文**

host（"Brain"）与沙箱（"Hands"）之间一条双向、按行分隔的 JSON 连接。每条消息是一行
一个 JSON 对象（stdio）或一个文本帧（WebSocket）。请求与响应靠 `id` 关联。

两种传输，同一套消息处理：

- **stdio** —— host 把 tool-server 当子进程拉起；按行分隔的 JSON 走 stdin/stdout。本地
  开发最简单。
- **WebSocket**（`--port N`）—— 沙箱暴露一个端口；host 持有一条持久 WS。**用 WebSocket，
  不要用 HTTP keep-alive**：转发是一条长生命周期、双向、流式的通道（progress 帧、控制
  帧、通知都往回走），这恰恰是 HTTP 请求/响应最不擅长的。

## 帧的类型

| 帧 | 方向 | 形状 | 响应 |
|----|------|------|------|
| **tool** | host → 沙箱 | `{ id, name, input, ctxIn }` | `{ id, ok:true, output, ctxDelta, newMessages? }` / `{ id, ok:false, error }` |
| **validate** | host → 沙箱 | `{ id, name, input, ctxIn, validateOnly:true }` | `{ id, ok:true, output: <校验结果> }` |
| **hook-exec** | host → 沙箱 | `{ id, type:'hook-exec', command, stdin, env, cwd, shell, timeoutMs }` | `{ id, ok:true, output:{ stdout, stderr, exitCode } }` |
| **control** | 双向 | `{ type:'control', op:'abort'\|'ping'\|'pong', id? }` | 无（fire-and-forget） |
| **progress** | 沙箱 → host | `{ id, type:'progress', data }` | 无（中间帧；后面跟一个最终 `ok`） |
| **notify** | 沙箱 → host | `{ type:'notify', command }` | 无（无 `id`） |

### tool

核心帧。host 已经做完 schema 校验和权限/hook 审批；沙箱只负责**执行**并返回 `output`
（= 工具的 `result.data`）。`ctxIn`/`ctxDelta` 承载状态契约（见下）。`newMessages` 携带
工具以消息形式产出的内容（比如读 PDF 抽出的图片），让 host 推进对话。

### validate

工具的 `validateInput` 可能**读文件系统**（"文件存在吗？""找到要替换的 `old_string`
没？""这个文件读过吗？"）。host 的磁盘视图是 turn 起始时的快照——最新的文件（shell
命令或之前的 `Write` 写的）只存在于沙箱。所以对写类工具，`validateInput` 被转发进沙箱、
用真实文件系统跑。它是只读的：不调 `call()`、不回 `ctxDelta`。**权限决策仍然在 host 做。**

### hook-exec

command 类型的 hook **不是工具**——它不出现在任何白名单上，agent/LLM 永远看不到它。
但不可信 workspace 能经自己的配置注入一个，而在 host 上跑它就是 RCE。所以 command hook
作为独立帧、在沙箱里跑。所有 hook *控制*（匹配、输出解析、exit-2-block 决策）都留在
host。详见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

### control

fire-and-forget，无响应：

- `abort` —— host 按 `id` 中断一个 in-flight 的调用/hook；沙箱中止真实进程。
- `ping` / `pong` —— 心跳。**关键：** 控制帧没有请求 `id`，所以代理/host 必须把它当
  无 id 的、**不要**记为 in-flight（否则崩溃恢复时它会被回放成 stale 传输错误）。详见
  [LESSONS.zh-CN.md](LESSONS.zh-CN.md)。

## ctx 状态契约（`ctxIn` / `ctxDelta`）

脑手分离执行里最难的问题：有些工具的*守卫*在 host 跑，而*它们依赖的读*在沙箱跑。

> host 是 ctx 状态的**唯一权威**。沙箱借状态来执行（`ctxIn`），把改了什么当数据回传
> （`ctxDelta`），host 用**自己的真函数**把改动落地。闭包永不过网。

**它解决的具体故障：** `Write`/`Edit` 的"写之前必须先读过该文件"守卫在 host 跑
（`validateInput`，转发之前），查的是 host 的 `readFileState`。但 `Read` 被*转发到沙箱*，
只更新了*沙箱的* `readFileState`。没有这个契约，host 永远看不到这次读，于是每次 Edit
都报 *"File has not been read yet"*。`Bash` 的 `cd` 改 `cwd` 是同样的问题。

`ctxIn`（host → 沙箱，只数据）：

| 字段 | 为什么 |
|------|--------|
| `cwd` | 让沙箱的工作目录与 host 对齐 |
| `readFileState` | 轻量（timestamp / isPartialView，**无 content**）——给"读过才能写"守卫和读去重播种 |
| `fileReadingLimits` | 工具遵守的大小/token 上限 |
| `agentId` / `agentType` | 纯 ctx 数据，忠实透传 |
| `userModified` | 用户是否改过提案输入（编辑工具会读） |
| `toolPermissionContext` | `additionalWorkingDirectories` 等——Bash 工具据此判断 `cd` 是否离开了项目；空集会误判合法的 cd 并重置 cwd。Map → entries。 |
| `planFilePath` | plan 模式：host 权威的 plan 路径（沙箱不能自己猜） |

`ctxDelta`（沙箱 → host，**增量**——逐条 apply，绝不整包覆盖，这样并发工具不会互相冲掉）：

| 字段 | 对 host 的作用 |
|------|----------------|
| `cwd` | `setCwdState(cwd)` |
| `readFileState` | 把每个 `set`/`delete` apply 到 host 权威缓存 |
| `nestedMemoryTriggers` | 加进 host 的"嵌套 memory"触发集（下一轮 query 注入） |
| `dynamicSkillTriggers` | 加进 host 的"动态 skill"触发集 |
| `planFileWrite` | 把 plan **内容**镜像到 host 权威 plan 路径——**丢弃沙箱回传的 path**（防穿越，见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)） |

host 侧实现在 `src/integration.ts`（`buildCtxIn`、`applyCtxDelta`）；沙箱侧在
`src/toolServer.ts`（播种 `ctxIn`，以及一个套在 `readFileState` 上的记录 `Proxy`，把
set/delete 捕获进 `ctxDelta`）。

## 失败语义

- **业务失败**（`ok:false`，无 `transport` 标志）—— 原样抛给 agent。工具是真失败了。
- **传输失败**（`ok:false` 且 `error.transport === true`，或连接断，或兜底超时）——
  沙箱/连接死了。host 转发层对**幂等**工具（Read/Glob/Grep/Write）带退避重试；非幂等
  工具则抛出去让 agent 决策（绝不把有副作用的 Edit/Bash 盲目重放进重建的沙箱）。
- `error.diag` 携带沙箱端 stack 的前几行，这样 host 日志就有真实原因，不必去取（用完
  即弃的）沙箱 stderr。

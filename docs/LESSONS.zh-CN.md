# 踩坑记录

[English](LESSONS.md) · **简体中文**

生产里跑出来的、不显而易见的故障。每一条都花过真实的调试时间；它们已经固化进代码，
在这里记下*为什么*代码长这样（也免得你"简化"时把 bug 改回来）。

## progress 帧绝不能删 in-flight 条目

流式工具（Bash）在最终的 `{ id, ok, output }` 之前会发很多 `{ type:'progress', id }`
帧。progress 帧带的是**同一个 `id`**。朴素的代理处理器对任何 id 匹配的帧都删 in-flight
条目——于是*第一个* progress 帧就把路由条目清空了，接着：

- 多 agent 路由下，最终的 `ok` 帧找不到它的发起者（流式结果丢失）；并且
- 沙箱中途崩溃时，恢复路径找不到这个调用、无法回一个传输错误，于是 agent 挂死到 turn
  超时。

规则：路由 progress 帧，但只在**最终**响应时删 in-flight 条目。在 `remoteClient.ts` 里
就是 `if ('type' in frame && frame.type === 'progress') { ...; return }` 这个早返回，
位于 `pending.delete` 之前。

## 控制帧没有请求 id —— 别把它记成 in-flight

`ping`/`pong`/`abort` 控制帧是 fire-and-forget。沙箱回的 `pong` 没有请求 `id`。如果代理
把它当响应去跟踪/关联，崩溃恢复时就会把它回放成一个 stale 传输错误。代理必须识别控制
帧并透传，不把它计入 in-flight。（在 `remoteClient.ts` 里，`notify` 和 `control` 路径都
在碰 `pending` 之前就返回了。）

## ctxDelta 必须增量 apply，不能整包覆盖

多个工具并发跑时，每个都回各自的 `ctxDelta`。如果 host 用一个 delta 覆盖它整个 ctx
状态，后到的 delta 会冲掉先到的（丢更新）。要逐条 apply：`setCwdState(delta.cwd)`，以及
按条目的 `readFileState.set/delete`——绝不替换整个 map。见 `applyCtxDelta`。

## "读过才能写"守卫在 host 跑，而 Read 在沙箱跑

这就是 `ctxIn`/`ctxDelta` 契约存在的全部理由。`Write`/`Edit` 校验文件先被读过——在
**host** 上，查 host 的 `readFileState`。但 `Read` 被转发、只更新了**沙箱的**状态。不经
`ctxDelta.readFileState` 把读回传，每次 Edit 都报 *"File has not been read yet"*。如果你
新增一个其行为依赖共享 ctx 状态的工具，把它接进这个契约——别在 host 侧硬编码回灌。见
[PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)。

## validateInput 有时需要真实文件系统

host 的磁盘是 turn 起始的快照。一条 shell 命令或之前的 `Write` 可能已经创建了下一个
`Edit` 的目标文件——但只在沙箱里。在 host 上跑 `validateInput`（它做 does-not-exist /
find-old-string 检查）会读到 stale 磁盘、拒掉合法的连续编辑。所以写类工具的
`validateInput` 被转发进沙箱。权限决策仍然在 host 做。

## detached 进程组，否则 hook 泄漏

用 `shell:true` spawn 的 hook 会 fork 孙子进程。对 child 发 `SIGKILL` 只杀掉 `/bin/sh`；
一个被 background 的孙子进程（`yes &`）仍持有 stdout 的写端 fd，于是 child 的 `close`
永不触发——调用挂死、in-flight 条目泄漏、输出上限被绕过（孙子进程继续吃内存）。要用
`detached:true` spawn 并杀整个进程组（`process.kill(-pid)`），再配一个宽限定时器：万一
`close` 还是不来就强制结算。

## 截断标记绝不能进内容体

hook 输出超上限时，别往 stdout/stderr 里追加"...truncated"标记。stderr 溢出把标记渗进
stdout 会破坏 host `parseHookOutput` 期望的 JSON——而解析失败会静默吞掉一个 block/deny
决策（fail-open）。把截断作为一个独立的帧顶层字段回传；内容体保持干净。

## idle 断连不总是崩溃

一条经 ingress/代理的长生命周期 WS 可能因 idle 被掐断。没有心跳的话，这个断看起来像
沙箱崩溃，触发一个无尽的重建循环、烧资源。一个周期性 `ping`（外加一个 `pong` 给回程
方向也制造流量）能把连接保活在 idle 阈值之下。注意：某些平台还会强加一个任何流量都
挡不住的**连接寿命硬上限**——对付那个要靠无缝重连（在稳定本地端点背后重建 + 重连），
而不是试图让一条连接永远活着。

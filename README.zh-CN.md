# agent-tool-server

[English](README.md) · **简体中文**

**为 Claude Code 兼容的 Agent 运行时提供"脑手分离"式沙箱。** 控制循环和所有凭据
留在 host，只把*工具执行*经一条持久连接转发进一次性沙箱。沙箱崩溃时，host 重连到
重建好的新沙箱，turn 继续——agent 全程无感。

这正是大多数 coding-agent 沙箱方案做反的地方：它们把*整个 agent* 塞进盒子里。这里
大脑留在盒子外：

```
host（"Brain"）  —— agent 循环、session、LLM key、权限/hook 审批、git
  │  一个 dispatch 切面：若处于远程模式 && 工具可转发，则只委托「执行」
  ▼  一条持久连接（本地走 stdio，或 ws:// 连沙箱）
[ 你的编排代理 ]  —— 稳定的本地端点、心跳、崩溃无缝恢复
  ▼
sandbox（"Hands"）—— `--tool-server`：用基座的「原生」工具操作 workspace
```

同一份 binary，两种模式。host 跑 agent 模式，沙箱跑 `--tool-server` 模式。因为两边
是*同一份工具代码*，工具行为逐字节一致——不用重新实现 Glob/Grep/Edit 语义，也没有
按 syscall 的 chatty RPC。

## 为什么是这个形状

- **凭据永不进沙箱。** LLM key、git 凭据、以及任何云/服务账号 token 都留在 host。
  沙箱是纯执行——它不调模型、不做 git，所以根本不需要这些。
- **沙箱是 cattle（用完即弃）。** workspace 在 per-task 卷上，session 在 host。崩了的
  沙箱用同一个卷重建、turn 恢复。in-flight 的幂等工具自动重试；非幂等工具把失败反馈
  给 agent 自己决策。
- **不可信代码碰不到 host。** workspace 能注入 command hook 和 MCP 配置；两者都被
  中和（hook 被转发进沙箱执行，详见 [SECURITY.zh-CN.md](docs/SECURITY.zh-CN.md)）。
- **关闭时零开销。** 不设 `REMOTE_TOOLS_URL` 时，host 走的就是原生路径，逐字节不变。
  切面只是一个 `if`。

## 仓库里有什么（以及没有什么）

本仓库只包含**转发层 + 协议**：

| 文件 | 侧 | 职责 |
|------|----|------|
| `src/toolServer.ts` | 沙箱 | `--tool-server` 模式：跑原生工具、hook、控制帧 |
| `src/remoteClient.ts` | host | 转发客户端（stdio / WebSocket、崩溃检测、兜底超时） |
| `src/integration.ts` | host | `buildCtxIn` / `applyCtxDelta` / `forwardToolCall` / `forwardValidateInput` / `forwardCommandHook`——你从 dispatch 调用的那层薄切面 |
| `src/servableTools.ts` | 两侧 | 可转发工具 / 幂等 / validate-转发 三张白名单 |
| `src/env.ts` | 两侧 | env 契约（`REMOTE_TOOLS_URL` 等） |
| `src/base.ts` | 两侧 | **唯一耦合点**——接到你的基座运行时，见下文 |

**不在范围内（这些由你提供）：**

- **你的 agent 基座。** 本包面向一个已经在 `src/base.ts` 暴露了工具接口的 Claude Code
  兼容运行时构建。它不附带基座，没有基座就无法运行。
- **编排代理 & 沙箱生命周期。** 供给沙箱、per-task 卷、稳定本地端点、心跳、崩溃重建
  都在*你的*基础设施里。协议本身为"中间放一个代理"留好了支持（传输错误 + 幂等重试），
  自带的 [docker 示例](examples/docker) 直接跑 tool-server（无代理），方便你端到端看
  清转发链路。

## 快速开始（本地，stdio）

最简单的接线：host 把 tool-server 当子进程自启，走 stdio。

1. 把 `src/base.ts` 接到你的基座运行时（就一个文件——见
   [INTEGRATION.zh-CN.md](docs/INTEGRATION.zh-CN.md)）。
2. 给你的 CLI 加上 `--tool-server` 入口：
   ```ts
   if (process.argv[2] === '--tool-server') {
     const { runToolServer } = await import('agent-tool-server/sandbox')
     await runToolServer(process.argv.slice(3))
     return
   }
   ```
3. 在你的 dispatch / hook 路径里加 3 个接入点（见
   [INTEGRATION.zh-CN.md](docs/INTEGRATION.zh-CN.md)）。
4. 用 `REMOTE_TOOLS_URL=stdio` 起 host——工具现在在子进程里执行。指向真实沙箱则用
   `REMOTE_TOOLS_URL=wss://host:port/`。

## 文档

- [docs/PROTOCOL.zh-CN.md](docs/PROTOCOL.zh-CN.md) —— 线上协议：四类帧，以及让 host 与
  沙箱保持同步的 `ctxIn`/`ctxDelta` 状态契约。
- [docs/INTEGRATION.zh-CN.md](docs/INTEGRATION.zh-CN.md) —— host 的 3 个接入点和 1 个
  基座接线文件，用语义锚点描述（不贴任何基座 diff）。
- [docs/SECURITY.zh-CN.md](docs/SECURITY.zh-CN.md) —— 凭据红线、hook 为何必须转发、
  plan 文件路径的防穿越规则、env 脱敏。
- [docs/LESSONS.zh-CN.md](docs/LESSONS.zh-CN.md) —— 我们踩过的非显而易见的坑，省得你再踩。

## 状态

从一套生产部署中抽取而来。1.0 之前 API 可能变动。欢迎贡献，也欢迎补一个参考用的
代理/provider 实现。

## 许可

[Apache-2.0](LICENSE)。

本项目设计为运行在你自行提供的 Claude Code 兼容 agent 运行时之内，不包含任何第三方
agent 代码。"Claude" 和 "Claude Code" 是 Anthropic 的商标——本项目与 Anthropic 无
关联、未获其背书，名称仅用于说明兼容性。

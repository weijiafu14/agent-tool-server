# 安全模型

[English](SECURITY.md) · **简体中文**

威胁模型是**不可信的 workspace 内容 + 不可信的模型输出**。agent 可能被诱导（文件里的
prompt 注入，或 workspace 自己的配置）去外泄凭据或在 host 上执行代码。脑手分离的设计
就是用来遏制这一点的，下面是让它成立的几条不变量。

## 红线（绝不跨越）

1. **LLM key、git 凭据、以及任何云/服务账号 token 永不进入沙箱。** 沙箱是纯执行：它
   不调模型、不做 git，所以根本不需要这些。它们留在 host。
2. **沙箱是 per-task、用完即弃的。** workspace 在 per-task 卷上，session 在 host。沙箱
   被销毁时没有任何有价值的东西丢失。
3. **沙箱供给失败时，绝不静默回退到"无隔离地跑不可信代码"。** 如果你有另一套隔离运行时
   就降级到它，否则 fail-closed。对不可信输入来说，无沙箱裸跑不是一个选项。（本包提供
   转发层；这条要*你*在编排里、供给失败时去强制执行。）

## 为什么 command hook 必须转发

command 类型 hook 被配置为在某些事件发生时运行一条 shell 命令。两个事实叠加成 host RCE：

- hook 配置可以来自 **workspace**（它自己的 settings 文件），而不可信 task 控制着它。
- hook 由 **host agent 进程**来 spawn——在工具 dispatch 路径之外，所以光有一个"工具执行
  切面"是盖不住它的。

放任不管的话，不可信 workspace 注入一个 command hook，就能在下一次事件时在 host 上拿到
任意代码执行——能读 git 私钥、host env，凡是 agent 进程能碰的都能碰。（我们在修复前端
到端实证过这一点。）

修法：command hook 作为独立的 **hook-exec 帧**、在*沙箱里*跑。hook **不是工具**——它不在
任何白名单上、不经过 `findToolByName`，所以 agent/LLM 永远看不到、也无法把它当工具调。
所有 hook *控制*（匹配、输出解析、exit-2-block 决策）都留在 host；只有 `exec` 被搬走。
见 `src/integration.ts`（`forwardCommandHook`）和 `src/toolServer.ts`（`handleHookExec`）。

### hook env 脱敏

只有 `CLAUDE_*` 键（hook env 约定）会跨进沙箱，而且即使这些也要过滤：

- `CLAUDE_ENV_FILE` 被丢弃（host home 路径，进沙箱对不上，还是 env-file 链的攻击面）。
- `CLAUDE_PLUGIN_OPTION_*` 被丢弃（可能携带敏感插件配置）。
- 一个黑名单兜底：凡键名命中
  `KEY|TOKEN|SECRET|OAUTH|CERT|PASS|CRED|AUTH|BEARER|INGRESS` 一律剔除，这样即便某个
  凭据恰好以 `CLAUDE_` 开头（如 `CLAUDE_*_TOKEN`）也永不过网。白名单*加*黑名单——别指
  望"敏感变量恰好不以 `CLAUDE_` 开头"。

host 系统 env 永不转发；沙箱把过滤后的 hook env merge 到它**自己的**进程 env 上。

## plan 文件写入要防路径穿越

plan 模式下，plan 文件由模型的 `Write` 写、而 `Write` 是被转发的——所以文件落在了沙箱
里。host 需要一份副本（它的审批卡片和 execute 阶段要读），于是沙箱经 `ctxDelta.planFileWrite`
把写入内容回传。

**host 绝不信任沙箱回传的 path。** 沙箱是不可信环境（模型甚至能篡改 tool-server 的内存
来伪造 path）；直接拿它去写，就是对任意 host 文件的路径穿越写入——覆盖
`~/.ssh/authorized_keys`、落一个 cron、改 git hook → host RCE。所以 host 自己重算权威
plan 路径（与它当初下发 `ctxIn.planFilePath` 同源），只把**内容**写到那里。回传的 path
若与之不符，会被记为攻击信号并丢弃。见 `src/integration.ts` 的 `applyCtxDelta`。

## 来自不可信 workspace 的 MCP

workspace 还能注入 MCP server 配置，这同样是与 hook 同等级的任意命令 host RCE。本包不
管理 MCP 配置，但你的 host 必须管：对不可信租户，**丢弃 workspace 来源和 user 来源的
MCP server**（只保留平台提供的），并以严格 MCP 配置启动 agent（不从 workspace 磁盘
自动发现）。

## 沙箱边界的纵深防御

转发协议假定沙箱是一个真正的隔离边界。它本身**不**提供这个边界——你的运行时才提供。
面向不可信输入的生产部署还应在平台层做：

- **egress**：默认 deny + 白名单；封死云元数据端点（`169.254.169.254`）；限制
  跨 pod / 内网网络。
- **不自动挂载 service-account token** 进沙箱 pod。
- **非 root、drop all capabilities、no-new-privileges、seccomp**；只读 rootfs；
  per-task workspace 卷，teardown 时销毁。
- 若输入完全不可信，用用户态内核或 microVM 运行时（gVisor / Kata / Firecracker），而
  不是共享内核的 namespace 沙箱——namespace 沙箱（如 bubblewrap）明确*不是*针对与你
  共享 host 内核的、有决心的攻击者的安全边界。

这些都在你的基础设施里，不在本包内。

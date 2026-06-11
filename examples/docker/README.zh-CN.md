# Docker 示例

[English](README.md) · **简体中文**

一个最小的、**无代理**的端到端跑法：host 直接连一个 tool-server，而不经过编排代理。
这是能跑通转发链路的最小东西；生产会在中间放一个代理来提供稳定端点 + 崩溃恢复（不在
本示例范围，见仓库 README）。

> 本示例是模板，不是开箱即用的拿来就跑。tool-server 需要你的基座运行时（它经
> `src/base.ts` 引入基座），所以你得构建一个包含你已接线的 agent 二进制的镜像。见
> [`Dockerfile`](Dockerfile)。

## 1. 本地、不用 Docker（最快的冒烟测试）

接好 `src/base.ts`、并让你的 CLI 路由 `--tool-server` 之后
（见 [INTEGRATION.zh-CN.md](../../docs/INTEGRATION.zh-CN.md)）：

```bash
# host 把 tool-server 当子进程经 stdio 自启：
REMOTE_TOOLS_URL=stdio <你的-agent>
```

跑一个会读文件、再改文件的 turn。在 host 日志里你应当看到成对的
`[remote] -> tool:Read` / `<- tool:Read ok`，接着 `-> tool:Edit` / `<- tool:Edit ok`，
且**没有** "File has not been read yet"——这就证明 ctx 契约在流转。

## 2. 容器、走 WebSocket

```bash
# 构建你的 tool-server 镜像（先按你的基座改 Dockerfile）：
docker build -t my-agent-tool-server examples/docker

# 跑它，暴露 WS 端口并挂一个 workspace 卷：
docker run --rm -p 9315:9315 -v "$PWD/workspace:/workspace" my-agent-tool-server

# 让 host 指向它：
REMOTE_TOOLS_URL=ws://127.0.0.1:9315/ <你的-agent>
```

host 现在把每个可转发工具经 WebSocket 转发；工具在容器里操作 `/workspace`。turn 进行中
杀掉容器，（前面有一个会重建它的代理时）host 会重连、turn 恢复——见仓库 README 和
[LESSONS.zh-CN.md](../../docs/LESSONS.zh-CN.md) 的崩溃恢复说明。

## 健康检查

对端口发一个非 WebSocket 的 `GET` 会返回 `200 tool-server ok`，可作 readiness 探针：

```bash
curl -s http://127.0.0.1:9315/    # -> tool-server ok
```

# Docker example

**English** · [简体中文](README.zh-CN.md)

A minimal, **proxy-less** end-to-end run: the host connects directly to a
tool-server instead of going through an orchestration proxy. This is the smallest
thing that exercises the forwarding path; production puts a proxy in the middle
for the stable endpoint + crash recovery (out of scope here, see the repo README).

> This example is a template, not a runnable drop-in. The tool-server needs your
> base runtime (it imports it via `src/base.ts`), so you must build an image that
> contains your wired agent binary. See [`Dockerfile`](Dockerfile).

## 1. Local, no Docker (fastest sanity check)

Once `src/base.ts` is wired and your CLI routes `--tool-server`
(see [INTEGRATION.md](../../docs/INTEGRATION.md)):

```bash
# The host self-spawns the tool-server as a child over stdio:
REMOTE_TOOLS_URL=stdio <your-agent>
```

Run a turn that reads and edits a file. In the host log you should see paired
`[remote] -> tool:Read` / `<- tool:Read ok`, then `-> tool:Edit` / `<- tool:Edit
ok` with **no** "File has not been read yet" — that confirms the ctx contract is
flowing.

## 2. Container over WebSocket

```bash
# Build your tool-server image (edit the Dockerfile for your base first):
docker build -t my-agent-tool-server examples/docker

# Run it, exposing the WS port and mounting a workspace volume:
docker run --rm -p 9315:9315 -v "$PWD/workspace:/workspace" my-agent-tool-server

# Point the host at it:
REMOTE_TOOLS_URL=ws://127.0.0.1:9315/ <your-agent>
```

The host now forwards every servable tool over the WebSocket; tools execute in
the container against `/workspace`. Kill the container mid-turn and (with a proxy
in front that rebuilds it) the host reconnects and the turn resumes — see the
crash-recovery notes in the repo README and [LESSONS.md](../../docs/LESSONS.md).

## Health check

A non-WebSocket `GET` to the port returns `200 tool-server ok`, suitable for a
readiness probe:

```bash
curl -s http://127.0.0.1:9315/    # -> tool-server ok
```

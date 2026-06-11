# Reference sandbox image for running the tool-server ("Hands" side).
#
# This is a TEMPLATE. The tool-server imports your base runtime through
# src/base.ts, so the image must contain your wired base binary/bundle. Replace
# the COPY/build steps below with however you produce your agent binary, then
# have its entrypoint launch tool-server mode.
#
# The image runs ONE thing: `<your-agent> --tool-server --port 9315`. It needs no
# LLM key and no git credentials — those stay on the host (see docs/SECURITY.md).

FROM oven/bun:1-slim

# --- your base goes here -----------------------------------------------------
# e.g. copy your built agent bundle (with src/base.ts wired to your base) in,
# install runtime deps, vendor ripgrep for Glob/Grep, etc.
WORKDIR /app
COPY . /app
RUN bun install --frozen-lockfile || true
# -----------------------------------------------------------------------------

# The workspace is mounted here at runtime from a per-task volume.
WORKDIR /workspace

# Execution-only. No secrets baked in.
ENV TOOL_SERVER_MODE=1
EXPOSE 9315

# Replace `bun run <entry>` with your agent's entrypoint; it must route
# `--tool-server` to runToolServer() (see docs/INTEGRATION.md §1).
ENTRYPOINT ["bun", "run", "your-agent-entry.ts", "--tool-server", "--port", "9315"]

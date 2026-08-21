# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps:

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- ACP client-side **filesystem** and **terminal** delegation are implemented (see "Client delegation" below).
- Ignore `mcpServers` for MVP (accept in params, store in session state).
- Stream all pi assistant output as ACP `agent_message_chunk` initially.
- Tool events: map pi tool execution events to ACP `tool_call` / `tool_call_update` (as text content).

## Client delegation

When the ACP client advertises `fs.readTextFile` / `fs.writeTextFile`, file access is
routed through the client so the editor owns agent edits (they land in its buffers as
reviewable, undoable changes) and reads observe unsaved work. When it advertises
`terminal`, pi's `bash` tool runs in a client-owned terminal (`terminal/create`) so the
editor renders a real PTY and its stop control maps to `terminal/kill`.

Pi performs its own file I/O and command execution inside its subprocess, so the adapter
cannot intercept them from the outside. Instead:

- `src/pi-ext/acp-client-fs.ts` is a **pi extension** loaded into the subprocess with
  `pi --extension`. It re-registers pi's own `read`/`write`/`edit`/`bash` tool definitions
  (`createReadToolDefinition` and friends) with custom `operations`, so schemas, result
  shapes, diffs and renderers stay identical to the built-ins and only the I/O is redirected.
- `src/acp/fs-bridge.ts` runs a local socket server in the adapter. The extension calls it;
  it forwards to the ACP client and falls back to disk if the client refuses or errors.
  It also owns the client terminal lifecycle and notifies the session, via
  `setTerminalListener`, of the `terminalId` to attach to the running `bash` tool call.
- `src/acp/client-fs.ts` is the adapter-side wrapper used for pre-edit diff snapshots.

Set `PI_ACP_DISABLE_CLIENT_FS=1` to force the legacy disk-only behavior.

Every path must stay tolerant of failure: a client error falls back to local disk (fs) or
pi's local shell (`createLocalBashOperations`, for bash), so the adapter still works with
clients that advertise a capability but reject specific paths or commands.

When the client owns the terminal, the session must not also emit the `_meta` pseudo-terminal
(`bashTerminalInfoMeta` and friends in `src/acp/translate/bash.ts`) or echo pi's captured
output — the client already renders both, and doing so duplicates the output.

## Dev workflow (to be filled once scaffold exists)

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Test: `npm run test`

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bashN
# Send initialize request via stdin (exact fields depend on ACP SDK version)
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!

## Client information

- Current ACP client is Zed

## References

- Local ACP repo with protocol documentation and specs: `~/Dev/learning/agent-client-protocol`
- Local Zed repo `~/Dev/learning/zed/zed`

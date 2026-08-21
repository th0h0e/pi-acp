import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ClientDelegationCapabilities } from './client-fs.js'

type BridgeRequest = {
  id?: unknown
  op?: unknown
  path?: unknown
  content?: unknown
  command?: unknown
  cwd?: unknown
  env?: unknown
  timeout?: unknown
  runId?: unknown
}

/** Notified when a client-side terminal is created, so the session can attach it to a tool call. */
export type TerminalListener = (info: { terminalId: string; command: string }) => void

function toEnvVariables(env: unknown): Array<{ name: string; value: string }> | undefined {
  if (!env || typeof env !== 'object') return undefined
  const out: Array<{ name: string; value: string }> = []
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string') out.push({ name, value })
  }
  return out.length ? out : undefined
}

let bridgeCounter = 0

function bridgeSocketPath(): string {
  const name = `pi-acp-fs-${process.pid}-${bridgeCounter++}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`)
}

export function resolveFsExtensionPath(): string | null {
  const candidates = [
    // Built layout: dist/index.js -> dist/acp-client-fs.js
    new URL('./acp-client-fs.js', import.meta.url),
    // Dev layout (tsx): src/acp/fs-bridge.ts -> src/pi-ext/acp-client-fs.ts
    new URL('../pi-ext/acp-client-fs.ts', import.meta.url)
  ]

  for (const url of candidates) {
    try {
      const p = fileURLToPath(url)
      if (existsSync(p)) return p
    } catch {
      // ignore and try the next candidate
    }
  }

  return null
}

/**
 * Local socket server that lets the pi extension (src/pi-ext/acp-client-fs.ts,
 * loaded into the pi subprocess via `pi -e`) delegate file reads and writes back
 * to the adapter, which routes them through the ACP client. This mirrors goose's
 * fs delegation: the editor owns agent writes, so they appear in its buffers.
 *
 * Protocol: newline-delimited JSON. Request {id, op: "read"|"write", path,
 * content?}; response {id, ok, content?(base64), error?}. Read responses are
 * base64 so binary disk fallbacks survive the trip.
 */
export class FsBridgeServer {
  private sessionId: string | null = null
  private terminalListener: TerminalListener | null = null
  /** Live client terminals keyed by the originating `terminal_run` request id. */
  private terminals = new Map<string, { kill: () => Promise<unknown> }>()

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly conn: AgentSideConnection,
    private readonly cwd: string,
    private readonly capabilities: ClientDelegationCapabilities,
    private readonly extensionPath: string
  ) {}

  static async maybeStart(opts: {
    conn: AgentSideConnection
    cwd: string
    capabilities?: ClientDelegationCapabilities
  }): Promise<FsBridgeServer | null> {
    const caps = opts.capabilities
    if (!caps || (!caps.readTextFile && !caps.writeTextFile && !caps.terminal)) return null
    if (process.env.PI_ACP_DISABLE_CLIENT_FS === '1') return null

    const extensionPath = resolveFsExtensionPath()
    if (!extensionPath) return null

    const socketPath = bridgeSocketPath()
    const server = createServer()
    const bridge = new FsBridgeServer(server, socketPath, opts.conn, opts.cwd, caps, extensionPath)
    server.on('connection', socket => bridge.handleConnection(socket))
    // The adapter's lifetime is driven by its stdio connection, never by this server.
    server.unref()

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch {
      // If the bridge can't listen, degrade to plain disk-based behavior.
      return null
    }

    return bridge
  }

  /** The ACP sessionId is only known after pi spawns; set it before the first prompt. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  spawnExtras(): { extensionPath: string; extraEnv: Record<string, string> } {
    return {
      extensionPath: this.extensionPath,
      extraEnv: {
        PI_ACP_FS_SOCKET: this.socketPath,
        PI_ACP_FS_READ: this.capabilities.readTextFile ? '1' : '0',
        PI_ACP_FS_WRITE: this.capabilities.writeTextFile ? '1' : '0',
        PI_ACP_TERMINAL: this.capabilities.terminal ? '1' : '0'
      }
    }
  }

  /** Register the session callback fired when a client terminal is created. */
  setTerminalListener(listener: TerminalListener): void {
    this.terminalListener = listener
  }

  close(): void {
    try {
      this.server.close()
    } catch {
      // ignore
    }
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.socketPath)
      } catch {
        // ignore
      }
    }
  }

  private handleConnection(socket: Socket): void {
    socket.unref()
    socket.on('error', () => {
      // The pi subprocess may go away at any time; requests fail individually.
    })
    const rl = createInterface({ input: socket })
    rl.on('line', line => {
      void this.handleLine(socket, line)
    })
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let req: BridgeRequest
    try {
      req = JSON.parse(line) as BridgeRequest
    } catch {
      return
    }

    const id = typeof req.id === 'string' ? req.id : null
    if (!id) return

    const respond = (payload: { ok: boolean; content?: string; error?: string; exitCode?: number | null }) => {
      try {
        socket.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch {
        // ignore; requester will observe the closed socket
      }
    }

    try {
      if (req.op === 'terminal_run') {
        const result = await this.runTerminal(id, req)
        respond({ ok: true, content: result.output, exitCode: result.exitCode })
        return
      }

      if (req.op === 'terminal_kill') {
        const runId = typeof req.runId === 'string' ? req.runId : null
        await this.terminals.get(runId ?? '')?.kill()
        respond({ ok: true })
        return
      }

      const path = typeof req.path === 'string' ? req.path : null
      if (!path) {
        respond({ ok: false, error: 'missing path' })
        return
      }
      const abs = isAbsolute(path) ? path : resolvePath(this.cwd, path)

      if (req.op === 'read') {
        const buffer = await this.readFile(abs)
        respond({ ok: true, content: buffer.toString('base64') })
      } else if (req.op === 'write') {
        await this.writeFile(abs, typeof req.content === 'string' ? req.content : '')
        respond({ ok: true })
      } else {
        respond({ ok: false, error: `unknown op: ${String(req.op)}` })
      }
    } catch (e) {
      respond({ ok: false, error: String((e as Error)?.message ?? e) })
    }
  }

  /**
   * Run a command in a client-owned terminal and wait for it to exit.
   *
   * The client spawns the process, so the user gets a real terminal in the editor
   * (proper PTY rendering, and a stop control wired to `terminal/kill`). Output is
   * collected once on exit purely so pi's tool result still carries it for the model;
   * the live view is the client's own.
   *
   * Throws if the client has no terminal capability or refuses, which the pi
   * extension treats as a signal to fall back to pi's local shell.
   */
  private async runTerminal(runId: string, req: BridgeRequest): Promise<{ output: string; exitCode: number | null }> {
    if (!this.capabilities.terminal || !this.sessionId) {
      throw new Error('client terminal capability unavailable')
    }

    const command = typeof req.command === 'string' ? req.command : ''
    if (!command.trim()) throw new Error('missing command')

    const cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : this.cwd
    const timeout = typeof req.timeout === 'number' && req.timeout > 0 ? req.timeout : undefined

    // pi hands us a full shell command line, so run it through a shell rather
    // than trying to split it into argv ourselves.
    const handle = await this.conn.createTerminal({
      sessionId: this.sessionId,
      command: 'bash',
      args: ['-c', command],
      cwd,
      env: toEnvVariables(req.env)
    })

    this.terminals.set(runId, { kill: () => handle.kill() })

    let timer: NodeJS.Timeout | undefined
    if (timeout) {
      timer = setTimeout(() => void handle.kill().catch(() => {}), timeout)
      timer.unref?.()
    }

    try {
      this.terminalListener?.({ terminalId: handle.id, command })
      await handle.waitForExit()
      const out = await handle.currentOutput()
      return {
        output: Buffer.from(out.output ?? '', 'utf8').toString('base64'),
        exitCode: out.exitStatus?.exitCode ?? null
      }
    } finally {
      if (timer) clearTimeout(timer)
      this.terminals.delete(runId)
      try {
        await handle.release()
      } catch {
        // ignore; the client may already have torn the terminal down
      }
    }
  }

  private async readFile(abs: string): Promise<Buffer> {
    if (this.capabilities.readTextFile && this.sessionId) {
      try {
        const res = await this.conn.readTextFile({ sessionId: this.sessionId, path: abs })
        return Buffer.from(res.content, 'utf8')
      } catch {
        // Client refused/errored (e.g. binary file); fall back to disk.
      }
    }
    return readFileSync(abs)
  }

  private async writeFile(abs: string, content: string): Promise<void> {
    if (this.capabilities.writeTextFile && this.sessionId) {
      try {
        await this.conn.writeTextFile({ sessionId: this.sessionId, path: abs, content })
        return
      } catch {
        // Client refused/errored; fall back to disk.
      }
    }
    writeFileSync(abs, content, 'utf8')
  }
}

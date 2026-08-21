import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { ClientFsCapabilities } from './client-fs.js'

type BridgeRequest = {
  id?: unknown
  op?: unknown
  path?: unknown
  content?: unknown
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

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly conn: AgentSideConnection,
    private readonly cwd: string,
    private readonly capabilities: ClientFsCapabilities,
    private readonly extensionPath: string
  ) {}

  static async maybeStart(opts: {
    conn: AgentSideConnection
    cwd: string
    capabilities?: ClientFsCapabilities
  }): Promise<FsBridgeServer | null> {
    const caps = opts.capabilities
    if (!caps || (!caps.readTextFile && !caps.writeTextFile)) return null
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
        PI_ACP_FS_WRITE: this.capabilities.writeTextFile ? '1' : '0'
      }
    }
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

    const respond = (payload: { ok: boolean; content?: string; error?: string }) => {
      try {
        socket.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch {
        // ignore; requester will observe the closed socket
      }
    }

    const path = typeof req.path === 'string' ? req.path : null
    if (!path) {
      respond({ ok: false, error: 'missing path' })
      return
    }
    const abs = isAbsolute(path) ? path : resolvePath(this.cwd, path)

    try {
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

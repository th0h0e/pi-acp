/**
 * Pi extension: route file reads and writes through the ACP client.
 *
 * pi-acp loads this into the pi subprocess (`pi -e`) when the ACP client
 * advertises `fs.readTextFile` / `fs.writeTextFile`. It overrides pi's built-in
 * `read`, `write` and `edit` tools with the *same* tool definitions, swapping only
 * their pluggable file operations so I/O is delegated over a local socket back to
 * the adapter, which forwards it to the client.
 *
 * Reusing pi's definitions keeps schemas, result shapes, diffs and renderers
 * identical to the built-ins; only who touches the file changes.
 *
 * This mirrors goose's `crates/goose/src/acp/fs.rs`: the editor performs agent
 * writes, so they land in its buffers as reviewable, undoable edits, and reads
 * observe unsaved changes.
 */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { access, mkdir } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

type BridgeResponse = { content?: string; exitCode?: number | null }
type Pending = { resolve: (value: BridgeResponse) => void; reject: (err: Error) => void }

/**
 * Client half of the bridge protocol: one socket, many concurrent requests
 * correlated by id. See src/acp/fs-bridge.ts for the server.
 */
class BridgeClient {
  private socket: Socket | null = null
  private connecting: Promise<Socket> | null = null
  private readonly pending = new Map<string, Pending>()
  private counter = 0

  constructor(private readonly socketPath: string) {}

  private async ensureSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket
    if (this.connecting) return this.connecting

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.socketPath)

      const onConnect = () => {
        socket.off('error', onError)
        // Idle bridge connections must not keep the pi process alive; request()
        // re-refs the socket while a call is in flight.
        socket.unref()

        const rl = createInterface({ input: socket })
        rl.on('line', line => this.handleLine(line))

        const fail = (err: Error) => {
          this.socket = null
          for (const [, p] of this.pending) p.reject(err)
          this.pending.clear()
        }
        socket.on('error', fail)
        socket.on('close', () => fail(new Error('pi-acp fs bridge closed')))

        this.socket = socket
        resolve(socket)
      }

      const onError = (err: Error) => {
        socket.off('connect', onConnect)
        reject(err)
      }

      socket.once('connect', onConnect)
      socket.once('error', onError)
    }).finally(() => {
      this.connecting = null
    })

    return this.connecting
  }

  private handleLine(line: string): void {
    let msg: { id?: unknown; ok?: unknown; content?: unknown; error?: unknown; exitCode?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    const id = typeof msg.id === 'string' ? msg.id : null
    if (!id) return

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    this.updateSocketRef()

    if (msg.ok === true) {
      pending.resolve({
        content: typeof msg.content === 'string' ? msg.content : undefined,
        exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null
      })
    } else {
      pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'pi-acp fs bridge request failed'))
    }
  }

  /** Keep the process alive only while the bridge has work outstanding. */
  private updateSocketRef(): void {
    if (!this.socket) return
    if (this.pending.size > 0) this.socket.ref()
    else this.socket.unref()
  }

  nextId(): string {
    return `${this.counter++}`
  }

  async request(payload: Record<string, unknown>, id = this.nextId()): Promise<BridgeResponse> {
    const socket = await this.ensureSocket()

    return new Promise<BridgeResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.updateSocketRef()
      socket.write(`${JSON.stringify({ id, ...payload })}\n`, err => {
        if (err) {
          this.pending.delete(id)
          this.updateSocketRef()
          reject(err)
        }
      })
    })
  }
}

// pi calls this on load. Which tools get overridden is decided entirely by the
// env vars the adapter set when spawning pi (see FsBridgeServer.spawnExtras),
// so a capability the client lacks simply leaves pi's built-in in place.
export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PI_ACP_FS_SOCKET
  if (!socketPath) return

  const canRead = process.env.PI_ACP_FS_READ === '1'
  const canWrite = process.env.PI_ACP_FS_WRITE === '1'
  const canRunTerminal = process.env.PI_ACP_TERMINAL === '1'
  if (!canRead && !canWrite && !canRunTerminal) return

  const bridge = new BridgeClient(socketPath)
  // pi-acp spawns pi with the session cwd, so this matches the ACP session cwd
  // that the adapter resolves relative paths against.
  const cwd = process.cwd()

  const readFile = async (absolutePath: string): Promise<Buffer> => {
    const res = await bridge.request({ op: 'read', path: absolutePath })
    return Buffer.from(res.content ?? '', 'base64')
  }

  const writeFile = async (absolutePath: string, content: string): Promise<void> => {
    await bridge.request({ op: 'write', path: absolutePath, content })
  }

  // Permission/existence checks stay local: the client writes to real paths, so
  // pi's normal filesystem errors remain accurate.
  const accessFile = async (absolutePath: string): Promise<void> => {
    await access(absolutePath)
  }

  if (canRead) {
    pi.registerTool(createReadToolDefinition(cwd, { operations: { readFile, access: accessFile } }))
  }

  if (canWrite) {
    pi.registerTool(
      createWriteToolDefinition(cwd, {
        operations: { writeFile, mkdir: async dir => void (await mkdir(dir, { recursive: true })) }
      })
    )
  }

  // edit needs both halves: read the current text, then write the result.
  if (canRead && canWrite) {
    pi.registerTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access: accessFile } }))
  }

  if (canRunTerminal) {
    const local = createLocalBashOperations()

    const exec: BashOperations['exec'] = async (command, execCwd, options) => {
      const runId = bridge.nextId()

      // pi aborts long-running commands via the signal; forward that to the
      // client so its terminal stop control and pi's own cancellation agree.
      const onAbort = () => void bridge.request({ op: 'terminal_kill', runId }).catch(() => {})
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const res = await bridge.request(
          {
            op: 'terminal_run',
            command,
            cwd: execCwd,
            env: options.env,
            timeout: options.timeout
          },
          runId
        )

        // The client renders output live in its own terminal; this hand-off exists
        // so pi's tool result still carries the text for the model.
        const output = Buffer.from(res.content ?? '', 'base64')
        if (output.length) options.onData(output)

        return { exitCode: res.exitCode ?? null }
      } catch {
        // No terminal capability, or the client refused: run it locally the way
        // stock pi would, so bash keeps working rather than failing the tool.
        return local.exec(command, execCwd, options)
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
    }

    pi.registerTool(createBashToolDefinition(cwd, { operations: { exec } }))
  }
}

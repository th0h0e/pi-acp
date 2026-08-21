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
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import { access, mkdir } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'

type Pending = { resolve: (value: { content?: string }) => void; reject: (err: Error) => void }

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
    let msg: { id?: unknown; ok?: unknown; content?: unknown; error?: unknown }
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
      pending.resolve({ content: typeof msg.content === 'string' ? msg.content : undefined })
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

  async request(op: 'read' | 'write', path: string, content?: string): Promise<{ content?: string }> {
    const socket = await this.ensureSocket()
    const id = `${this.counter++}`

    return new Promise<{ content?: string }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.updateSocketRef()
      socket.write(`${JSON.stringify({ id, op, path, content })}\n`, err => {
        if (err) {
          this.pending.delete(id)
          this.updateSocketRef()
          reject(err)
        }
      })
    })
  }
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.PI_ACP_FS_SOCKET
  if (!socketPath) return

  const canRead = process.env.PI_ACP_FS_READ === '1'
  const canWrite = process.env.PI_ACP_FS_WRITE === '1'
  if (!canRead && !canWrite) return

  const bridge = new BridgeClient(socketPath)
  // pi-acp spawns pi with the session cwd, so this matches the ACP session cwd
  // that the adapter resolves relative paths against.
  const cwd = process.cwd()

  const readFile = async (absolutePath: string): Promise<Buffer> => {
    const res = await bridge.request('read', absolutePath)
    return Buffer.from(res.content ?? '', 'base64')
  }

  const writeFile = async (absolutePath: string, content: string): Promise<void> => {
    await bridge.request('write', absolutePath, content)
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
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { FsBridgeServer } from '../../src/acp/fs-bridge.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

type BridgeReply = { id: string; ok: boolean; content?: string; error?: string; exitCode?: number | null }

/** Minimal stand-in for the pi-side extension client, speaking the raw bridge protocol. */
class TestBridgeClient {
  private counter = 0
  private readonly pending = new Map<string, (reply: BridgeReply) => void>()

  private constructor(private readonly socket: Socket) {
    createInterface({ input: socket }).on('line', line => {
      const reply = JSON.parse(line) as BridgeReply
      const resolve = this.pending.get(reply.id)
      if (resolve) {
        this.pending.delete(reply.id)
        resolve(reply)
      }
    })
  }

  static async connect(socketPath: string): Promise<TestBridgeClient> {
    const socket = connect(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return new TestBridgeClient(socket)
  }

  send(payload: Record<string, unknown>, id = `${this.counter++}`): Promise<BridgeReply> {
    return new Promise<BridgeReply>(resolve => {
      this.pending.set(id, resolve)
      this.socket.write(`${JSON.stringify({ id, ...payload })}\n`)
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

async function startTerminalBridge(conn: FakeAgentSideConnection) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-term-')))
  const bridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(conn),
    cwd,
    capabilities: { readTextFile: false, writeTextFile: false, terminal: true }
  })
  assert.ok(bridge, 'expected bridge to start for terminal-only capability')
  bridge.setSessionId('s1')
  return { bridge, cwd }
}

test('terminal bridge: starts when only the terminal capability is advertised', async () => {
  const conn = new FakeAgentSideConnection()
  const { bridge } = await startTerminalBridge(conn)

  assert.equal(bridge.spawnExtras().extraEnv.PI_ACP_TERMINAL, '1')
  bridge.close()
})

test('terminal bridge: runs a command in a client terminal and returns its output', async () => {
  const conn = new FakeAgentSideConnection()
  conn.terminalOutput = 'hello from zed\n'
  conn.terminalExitCode = 0

  const { bridge, cwd } = await startTerminalBridge(conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const reply = await client.send({ op: 'terminal_run', command: 'echo hi', cwd })

  assert.equal(reply.ok, true, 'expected terminal run to succeed')
  assert.equal(reply.exitCode, 0)
  assert.equal(Buffer.from(reply.content ?? '', 'base64').toString('utf8'), 'hello from zed\n')

  assert.equal(conn.createTerminalRequests.length, 1, 'expected one client terminal')
  const req = conn.createTerminalRequests[0]
  // pi hands us a shell command line, so it must run through a shell rather than argv.
  assert.equal(req.command, 'bash')
  assert.deepEqual(req.args, ['-c', 'echo hi'])
  assert.equal(req.cwd, cwd)

  assert.equal(conn.releasedTerminals.length, 1, 'expected the terminal to be released')

  client.close()
  bridge.close()
})

test('terminal bridge: notifies the session of the created terminal id', async () => {
  const conn = new FakeAgentSideConnection()
  const { bridge, cwd } = await startTerminalBridge(conn)

  const seen: Array<{ terminalId: string; command: string }> = []
  bridge.setTerminalListener(info => seen.push(info))

  const client = await TestBridgeClient.connect(bridge.socketPath)
  await client.send({ op: 'terminal_run', command: 'npm test', cwd })

  assert.equal(seen.length, 1, 'expected one terminal notification')
  assert.equal(seen[0].command, 'npm test')
  assert.match(seen[0].terminalId, /^term_/)

  client.close()
  bridge.close()
})

test('terminal bridge: kills a running command on request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.holdTerminals = true

  const { bridge, cwd } = await startTerminalBridge(conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  // Runs until killed, so this stays pending.
  const running = client.send({ op: 'terminal_run', command: 'sleep 100', cwd }, 'run-1')

  // Wait until the client terminal actually exists before killing it.
  while (conn.createTerminalRequests.length === 0) await new Promise(r => setTimeout(r, 5))

  const killReply = await client.send({ op: 'terminal_kill', runId: 'run-1' })
  assert.equal(killReply.ok, true)

  const reply = await running
  assert.equal(reply.ok, true, 'killed command should still report a result')
  assert.equal(conn.killedTerminals.length, 1, 'expected the client terminal to be killed')

  client.close()
  bridge.close()
})

test('terminal bridge: reports an error when the client refuses a terminal', async () => {
  const conn = new FakeAgentSideConnection()
  conn.failCreateTerminal = true

  const { bridge, cwd } = await startTerminalBridge(conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const reply = await client.send({ op: 'terminal_run', command: 'ls', cwd })

  // The pi extension treats this as its cue to fall back to pi's local shell.
  assert.equal(reply.ok, false, 'expected the refusal to surface as an error')
  assert.match(String(reply.error), /refused/)

  client.close()
  bridge.close()
})

test('terminal bridge: refuses to run without the terminal capability', async () => {
  const conn = new FakeAgentSideConnection()
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-term-')))
  const bridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(conn),
    cwd,
    capabilities: { readTextFile: true, writeTextFile: true, terminal: false }
  })
  assert.ok(bridge)
  bridge.setSessionId('s1')

  const client = await TestBridgeClient.connect(bridge.socketPath)
  const reply = await client.send({ op: 'terminal_run', command: 'ls', cwd })

  assert.equal(reply.ok, false)
  assert.equal(conn.createTerminalRequests.length, 0, 'must not call the client without the capability')

  client.close()
  bridge.close()
})

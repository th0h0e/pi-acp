import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBridgeServer } from '../../src/acp/fs-bridge.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

async function startSession(conn: FakeAgentSideConnection, terminal: boolean) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-session-term-')))
  const proc = new FakePiRpcProcess()

  const fsBridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(conn),
    cwd,
    capabilities: { readTextFile: false, writeTextFile: false, terminal }
  })
  fsBridge?.setSessionId('s1')

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    delegationCapabilities: { readTextFile: false, writeTextFile: false, terminal },
    fsBridge
  })

  return { session, proc, conn, fsBridge, cwd }
}

const settle = () => new Promise(r => setTimeout(r, 0))

test('session: attaches the client terminal id to the bash tool call', async () => {
  const conn = new FakeAgentSideConnection()
  const { proc, fsBridge } = await startSession(conn, true)
  assert.ok(fsBridge, 'expected a bridge when terminal is advertised')

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } })
  await settle()

  const start = conn.updates[0]!.update as any
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.equal(start.kind, 'execute')
  // The real terminal does not exist yet, so no synthetic terminal is announced.
  assert.equal(start.content, undefined, 'should not synthesize a terminal when delegating')
  assert.equal(start._meta, undefined, 'should not emit terminal_info when delegating')

  // Drive a real terminal_run over the bridge socket, the way the pi extension does.
  const socket = connect(fsBridge.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(`${JSON.stringify({ id: 'r1', op: 'terminal_run', command: 'ls -la' })}\n`)

  while (conn.updates.length < 2) await settle()

  const attach = conn.updates[1]!.update as any
  assert.equal(attach.sessionUpdate, 'tool_call_update')
  assert.equal(attach.toolCallId, 't1')
  assert.deepEqual(attach.content, [{ type: 'terminal', terminalId: 'term_0' }])
  assert.equal(conn.createTerminalRequests.length, 1, 'expected the client to have spawned the command')

  socket.destroy()
  fsBridge.close()
})

test('session: does not echo pi output when the client owns the terminal', async () => {
  const conn = new FakeAgentSideConnection()
  const { proc, fsBridge } = await startSession(conn, true)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'partial output' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'final output' }] }
  })
  await settle()

  const metas = conn.updates.map(u => (u.update as any)._meta).filter(Boolean)
  assert.equal(metas.length, 0, 'client terminal already renders output and exit status')

  const last = conn.updates.at(-1)!.update as any
  assert.equal(last.status, 'completed', 'status must still be reported')

  fsBridge?.close()
})

test('session: keeps the synthetic terminal when the client has no terminal capability', async () => {
  const conn = new FakeAgentSideConnection()
  const { proc, fsBridge } = await startSession(conn, false)
  assert.equal(fsBridge, null, 'no bridge without any delegation capability')

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  await settle()

  const start = conn.updates[0]!.update as any
  assert.deepEqual(start.content, [{ type: 'terminal', terminalId: 't1' }])
  assert.ok(start._meta?.terminal_info, 'falls back to the _meta pseudo-terminal')
})

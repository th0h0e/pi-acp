import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function newSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

const ids = (conn: FakeAgentSideConnection) => conn.updates.map(u => (u.update as any).messageId)
const settle = () => new Promise(r => setTimeout(r, 0))

test('PiAcpSession: consecutive text deltas share one messageId', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  for (const delta of ['Hel', 'lo ', 'world']) {
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
  }

  await settle()

  const [first] = ids(conn)
  assert.equal(conn.updates.length, 3)
  assert.ok(first)
  assert.deepEqual(ids(conn), [first, first, first])
})

test('PiAcpSession: a new pi message starts a new messageId', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'one' } })
  proc.emit({ type: 'message_end', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } })

  await settle()

  const [a, b] = ids(conn)
  assert.notEqual(a, b)
})

test('PiAcpSession: the user message boundary does not open an assistant message', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  // pi brackets the user's own prompt too; that must not consume the assistant's id.
  proc.emit({ type: 'message_start', message: { role: 'user' } } as any)
  proc.emit({ type: 'message_end', message: { role: 'user' } } as any)
  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } })

  await settle()

  const [a, b] = ids(conn)
  assert.equal(conn.updates.length, 2)
  assert.equal(a, b)
})

test('PiAcpSession: thinking and text from one pi message are distinct ACP messages', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } })

  await settle()

  const [thought, text] = ids(conn)
  assert.notEqual(thought, text)
})

test('PiAcpSession: deltas with no preceding message_start still get an id', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  // Older pi builds, or a stream joined mid-message, never send the opening boundary.
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'y' } })

  await settle()

  const [a, b] = ids(conn)
  assert.ok(a)
  assert.equal(a, b)
})

test('PiAcpSession: standalone notices never join the streamed reply', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  newSession(conn, proc)

  proc.emit({ type: 'message_start', message: { role: 'assistant' } } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })
  proc.emit({ type: 'auto_compaction_start' } as any)
  proc.emit({ type: 'auto_compaction_end' } as any)

  await settle()

  const [reply, start, end] = ids(conn)
  assert.equal(new Set([reply, start, end]).size, 3)
})

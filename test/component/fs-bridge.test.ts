import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { FsBridgeServer, resolveFsExtensionPath } from '../../src/acp/fs-bridge.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

type BridgeReply = { id: string; ok: boolean; content?: string; error?: string }

/** Minimal stand-in for the pi-side extension client. */
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

  request(op: 'read' | 'write', path: string, content?: string): Promise<BridgeReply> {
    const id = `${this.counter++}`
    return new Promise<BridgeReply>(resolve => {
      this.pending.set(id, resolve)
      this.socket.write(`${JSON.stringify({ id, op, path, content })}\n`)
    })
  }

  close(): void {
    this.socket.destroy()
  }
}

async function startBridge(cwd: string, conn: FakeAgentSideConnection) {
  const bridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(conn),
    cwd,
    capabilities: { readTextFile: true, writeTextFile: true, terminal: false }
  })
  assert.ok(bridge, 'expected bridge to start')
  bridge.setSessionId('s1')
  return bridge
}

test('fs bridge: ships the pi extension it tells pi to load', () => {
  const path = resolveFsExtensionPath()
  assert.ok(path, 'expected to resolve the pi extension file')
  assert.match(path, /acp-client-fs\.(ts|js)$/)
})

test('fs bridge: is not started when the client advertises no fs capabilities', async () => {
  const bridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(new FakeAgentSideConnection()),
    cwd: mkdtempSync(join(tmpdir(), 'pi-acp-bridge-')),
    capabilities: { readTextFile: false, writeTextFile: false, terminal: false }
  })
  assert.equal(bridge, null, 'expected no bridge without fs capabilities')
})

test('fs bridge: routes writes through the ACP client instead of disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'original\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  const bridge = await startBridge(dir, conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const reply = await client.request('write', 'a.txt', 'from agent\n')
  assert.equal(reply.ok, true, 'expected write to succeed')

  assert.equal(conn.writeTextFileRequests.length, 1, 'expected one client write')
  assert.equal(conn.writeTextFileRequests[0].path, filePath, 'expected relative path resolved against cwd')
  assert.equal(conn.writeTextFileRequests[0].content, 'from agent\n')

  // The client owns the write, so the adapter must not also touch disk.
  assert.equal(readFileSync(filePath, 'utf8'), 'original\n', 'expected disk to be left to the client')

  client.close()
  bridge.close()
})

test('fs bridge: serves reads from the client buffer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'stale on disk\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  conn.clientFileContent = 'unsaved buffer\n'
  const bridge = await startBridge(dir, conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const reply = await client.request('read', 'a.txt')
  assert.equal(reply.ok, true, 'expected read to succeed')
  assert.equal(Buffer.from(reply.content ?? '', 'base64').toString('utf8'), 'unsaved buffer\n')

  client.close()
  bridge.close()
})

test('fs bridge: falls back to disk when the client refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'on disk\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  conn.failClientWrites = true // and clientFileContent stays null, so reads reject too
  const bridge = await startBridge(dir, conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const read = await client.request('read', 'a.txt')
  assert.equal(read.ok, true, 'expected read to fall back to disk')
  assert.equal(Buffer.from(read.content ?? '', 'base64').toString('utf8'), 'on disk\n')

  const write = await client.request('write', 'a.txt', 'written locally\n')
  assert.equal(write.ok, true, 'expected write to fall back to disk')
  assert.equal(readFileSync(filePath, 'utf8'), 'written locally\n')

  client.close()
  bridge.close()
})

test('fs bridge: reports an error for a missing file rather than hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-bridge-'))
  const conn = new FakeAgentSideConnection()
  const bridge = await startBridge(dir, conn)
  const client = await TestBridgeClient.connect(bridge.socketPath)

  const reply = await client.request('read', 'missing.txt')
  assert.equal(reply.ok, false, 'expected failure for missing file')
  assert.ok(reply.error, 'expected an error message')

  client.close()
  bridge.close()
})

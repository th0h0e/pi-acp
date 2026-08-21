/**
 * End-to-end test of the write-delegation path, without an LLM:
 *
 *   extension factory -> pi's real edit/write/read tool definitions
 *     -> bridge socket client -> bridge server -> ACP client
 *
 * Everything except the ACP client itself is production code, including pi's
 * own tool implementations pulled from the installed pi package.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { FsBridgeServer } from '../../src/acp/fs-bridge.js'
import createAcpClientFsExtension from '../../src/pi-ext/acp-client-fs.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

type AnyToolDefinition = ToolDefinition<never, never, never>

/** Captures what the extension registers, standing in for pi's ExtensionAPI. */
function fakeExtensionApi() {
  const tools = new Map<string, AnyToolDefinition>()
  return {
    api: { registerTool: (tool: AnyToolDefinition) => tools.set(tool.name, tool) },
    tools
  }
}

async function setup(cwd: string, conn: FakeAgentSideConnection) {
  const bridge = await FsBridgeServer.maybeStart({
    conn: asAgentConn(conn),
    cwd,
    capabilities: { readTextFile: true, writeTextFile: true }
  })
  assert.ok(bridge, 'expected bridge to start')
  bridge.setSessionId('s1')

  const { extraEnv } = bridge.spawnExtras()
  const previous = { ...process.env }
  Object.assign(process.env, extraEnv)

  // The extension resolves cwd from process.cwd(), matching how pi-acp spawns pi.
  const previousCwd = process.cwd()
  process.chdir(cwd)

  const { api, tools } = fakeExtensionApi()
  createAcpClientFsExtension(api as never)

  const restore = () => {
    process.chdir(previousCwd)
    for (const key of Object.keys(extraEnv)) delete process.env[key]
    Object.assign(process.env, previous)
    bridge.close()
  }

  return { tools, restore }
}

function runTool(tool: AnyToolDefinition, params: unknown) {
  return tool.execute('call-1', params as never, undefined, undefined, { cwd: process.cwd() } as never)
}

test("pi extension: registers overrides for pi's read, write and edit tools", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-ext-')))
  const conn = new FakeAgentSideConnection()
  const { tools, restore } = await setup(dir, conn)

  assert.deepEqual([...tools.keys()].sort(), ['edit', 'read', 'write'])

  restore()
})

test('pi extension: edit routes the write through the ACP client, not disk', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-ext-')))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'line one\nline two\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  conn.clientFileContent = 'line one\nline two\n'
  const { tools, restore } = await setup(dir, conn)

  await runTool(tools.get('edit')!, {
    path: 'a.txt',
    edits: [{ oldText: 'line two', newText: 'line two edited' }]
  })

  assert.equal(conn.writeTextFileRequests.length, 1, 'expected the edit to be written via the client')
  assert.equal(conn.writeTextFileRequests[0].path, filePath)
  assert.equal(conn.writeTextFileRequests[0].content, 'line one\nline two edited\n')

  // The client owns the buffer; pi must not have written to disk itself.
  assert.equal(readFileSync(filePath, 'utf8'), 'line one\nline two\n', 'expected disk untouched by the agent')

  restore()
})

test('pi extension: edit reads the client buffer, so it sees unsaved changes', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-ext-')))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  // Disk lacks the text being edited; only the unsaved buffer has it.
  writeFileSync(filePath, 'stale disk content\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  conn.clientFileContent = 'unsaved marker\n'
  const { tools, restore } = await setup(dir, conn)

  await runTool(tools.get('edit')!, {
    path: 'a.txt',
    edits: [{ oldText: 'unsaved marker', newText: 'replaced' }]
  })

  assert.equal(conn.writeTextFileRequests.length, 1, 'edit should succeed against the unsaved buffer')
  assert.equal(conn.writeTextFileRequests[0].content, 'replaced\n')

  restore()
})

test('pi extension: write routes new file creation through the ACP client', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-ext-')))
  mkdirSync(dir, { recursive: true })

  const conn = new FakeAgentSideConnection()
  const { tools, restore } = await setup(dir, conn)

  await runTool(tools.get('write')!, { path: 'new.txt', content: 'created\n' })

  assert.equal(conn.writeTextFileRequests.length, 1, 'expected write via the client')
  assert.equal(conn.writeTextFileRequests[0].path, join(dir, 'new.txt'))
  assert.equal(conn.writeTextFileRequests[0].content, 'created\n')

  restore()
})

test('pi extension: read serves the client buffer instead of disk', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pi-acp-ext-')))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'stale disk content\n', 'utf8')

  const conn = new FakeAgentSideConnection()
  conn.clientFileContent = 'unsaved buffer content\n'
  const { tools, restore } = await setup(dir, conn)

  const result = await runTool(tools.get('read')!, { path: 'a.txt' })

  const text = JSON.stringify(result)
  assert.ok(text.includes('unsaved buffer content'), `expected buffer content in read result, got: ${text}`)
  assert.ok(!text.includes('stale disk content'), 'read must not fall back to disk when the buffer is available')

  restore()
})

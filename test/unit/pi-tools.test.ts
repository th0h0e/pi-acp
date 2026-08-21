import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultToText, toToolKind } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toToolKind: maps pi built-in tools to ACP tool kinds', () => {
  assert.equal(toToolKind('read'), 'read')
  assert.equal(toToolKind('ls'), 'read')
  assert.equal(toToolKind('write'), 'edit')
  assert.equal(toToolKind('edit'), 'edit')
  assert.equal(toToolKind('grep'), 'search')
  assert.equal(toToolKind('find'), 'search')
  assert.equal(toToolKind('bash'), 'execute')
})

test('toToolKind: unknown tools fall back to other', () => {
  assert.equal(toToolKind('mcp__server__thing'), 'other')
  assert.equal(toToolKind(''), 'other')
})

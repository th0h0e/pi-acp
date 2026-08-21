import test from 'node:test'
import assert from 'node:assert/strict'
import { supportedThinkingLevels, clampThinkingLevel } from '../../src/acp/agent.js'

const ALL = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

test('supportedThinkingLevels: no map means defaults up to high, and no opt-in xhigh', () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high'])
})

test('supportedThinkingLevels: a null entry marks the level unsupported', () => {
  // openrouter/deepseek/deepseek-v4-flash-0731
  const levels = supportedThinkingLevels({
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: null, xhigh: 'xhigh' }
  })
  assert.deepEqual(levels, ['off', 'high', 'xhigh'])
})

test('supportedThinkingLevels: a sparse map keeps the omitted levels and opts into xhigh', () => {
  // openrouter/z-ai/glm-5.2 — only xhigh is listed, so everything else falls back to defaults.
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } }), ALL)
})

test('supportedThinkingLevels: non-reasoning models offer only off', () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ['off'])
})

test('supportedThinkingLevels: an unknown model falls back to the default set', () => {
  assert.deepEqual(supportedThinkingLevels(null), ['off', 'minimal', 'low', 'medium', 'high'])
})

test('clampThinkingLevel: keeps a supported level untouched', () => {
  assert.equal(clampThinkingLevel('high', ['off', 'high', 'xhigh']), 'high')
})

test('clampThinkingLevel: falls back to the nearest level below', () => {
  // glm-5.2 (xhigh) -> glm-5.2:free (no xhigh)
  assert.equal(clampThinkingLevel('xhigh', ['off', 'minimal', 'low', 'medium', 'high']), 'high')
  assert.equal(clampThinkingLevel('medium', ['off', 'high', 'xhigh']), 'off')
})

test('clampThinkingLevel: uses the lowest supported level when nothing is below', () => {
  assert.equal(clampThinkingLevel('off', ['high', 'xhigh']), 'high')
})

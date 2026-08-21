import test from 'node:test'
import assert from 'node:assert/strict'
import { applyModelScope } from '../../src/acp/agent.js'

const models = [
  { modelId: 'openrouter/alpha', name: 'openrouter/Alpha', description: null },
  { modelId: 'openrouter/beta', name: 'openrouter/Beta', description: null },
  { modelId: 'openrouter/gamma', name: 'openrouter/Gamma', description: null }
]

const ids = (list: ReturnType<typeof applyModelScope>) => list.map(m => m.modelId)

test('applyModelScope: narrows to the scoped selection', () => {
  const scoped = applyModelScope(models, 'openrouter/alpha', ['openrouter/alpha', 'openrouter/gamma'])
  assert.deepEqual(ids(scoped), ['openrouter/alpha', 'openrouter/gamma'])
})

test('applyModelScope: an empty scope means no scoping, not no models', () => {
  assert.deepEqual(ids(applyModelScope(models, 'openrouter/alpha', [])), ids(models))
})

test('applyModelScope: keeps the current model even when it is unscoped', () => {
  // pi's defaultModel need not appear in enabledModels; currentValue must stay selectable.
  const scoped = applyModelScope(models, 'openrouter/beta', ['openrouter/alpha'])
  assert.deepEqual(ids(scoped), ['openrouter/alpha', 'openrouter/beta'])
})

test('applyModelScope: ignores scope entries that match no known model', () => {
  const scoped = applyModelScope(models, 'openrouter/alpha', ['openrouter/alpha', 'openrouter/deleted'])
  assert.deepEqual(ids(scoped), ['openrouter/alpha'])
})

test('applyModelScope: falls back to all models when the scope resolves to nothing', () => {
  assert.deepEqual(ids(applyModelScope(models, null, ['openrouter/deleted'])), ids(models))
})

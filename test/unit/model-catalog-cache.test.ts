import test from 'node:test'
import assert from 'node:assert/strict'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

/**
 * Drive the real accessor without a pi subprocess by standing in for the one round trip
 * it makes. Caching is the behavior under test, so the count of those trips is the point.
 */
function stubProcess(respond: () => { success: boolean; data?: unknown; error?: string }) {
  const proc = Object.create(PiRpcProcess.prototype) as PiRpcProcess
  const calls = { n: 0 }
  ;(proc as any).availableModels = null
  ;(proc as any).request = async () => {
    calls.n++
    return respond()
  }
  return { proc, calls }
}

test('getAvailableModels: fetches pi once and serves the rest from cache', async () => {
  const { proc, calls } = stubProcess(() => ({ success: true, data: { models: [{ id: 'a' }] } }))

  const first = await proc.getAvailableModels()
  const second = await proc.getAvailableModels()

  assert.equal(calls.n, 1)
  assert.deepEqual(first, { models: [{ id: 'a' }] })
  assert.equal(second, first)
})

test('getAvailableModels: concurrent callers share a single round trip', async () => {
  const { proc, calls } = stubProcess(() => ({ success: true, data: { models: [] } }))

  // getSessionConfiguration resolves the model and thinking state in parallel, so this
  // is the real access pattern, not a contrived one.
  await Promise.all([proc.getAvailableModels(), proc.getAvailableModels(), proc.getAvailableModels()])

  assert.equal(calls.n, 1)
})

test('getAvailableModels: a failure is not cached', async () => {
  let fail = true
  const { proc, calls } = stubProcess(() =>
    fail ? { success: false, error: 'pi not ready' } : { success: true, data: { models: [{ id: 'a' }] } }
  )

  await assert.rejects(() => proc.getAvailableModels(), /pi not ready/)

  fail = false
  assert.deepEqual(await proc.getAvailableModels(), { models: [{ id: 'a' }] })
  assert.equal(calls.n, 2)
})

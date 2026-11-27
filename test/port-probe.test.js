// helper 的端口探测必须认出「占着端口但不 accept」的卡死 host。
// 旧的 net.connect 探测在这种情况下超时 -> 误判成端口空闲 -> helper 不清旧 host
// 就拉起新实例，留下占着几 GB 的僵尸进程。

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { listening } = require('../lib/helper.cjs')

test('端口空闲时返回 false', async () => {
  const probe = net.createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  assert.equal(await listening(port), false)
})

test('卡死的 host（占着端口但不 accept）返回 true', async () => {
  const wedged = net.createServer(() => {})  // 占端口但不在 connect 时回调
  await new Promise((r) => wedged.listen(0, '127.0.0.1', r))
  const port = wedged.address().port
  try {
    assert.equal(await listening(port), true)
  } finally {
    wedged.close()
    await new Promise((r) => setTimeout(r, 50))
  }
})

test('host 退出后端口释放，返回 false', async () => {
  const wedged = net.createServer(() => {})
  await new Promise((r) => wedged.listen(0, '127.0.0.1', r))
  const port = wedged.address().port
  assert.equal(await listening(port), true)
  wedged.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(await listening(port), false)
})

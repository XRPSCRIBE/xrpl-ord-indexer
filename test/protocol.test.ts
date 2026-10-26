import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { MEMO_LIMIT, fromXrplMemos, memosSize, utf8 } from '../src/memo.js'
import {
  EnvelopeError,
  buildChunkTx,
  buildRevealTx,
  chunkCapacity,
  normalizeContentType,
  parseEnvelope,
  parseInscriptionId,
  planInscription,
  sha256,
} from '../src/protocol.js'

const ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const HASH_A = 'A'.repeat(64)

test('memosSize matches rippled serialization', () => {
  // ord memo: EA 7C 03 'ord' 7D <2-byte VL> 962 bytes E1 = 972
  // prev memo: EA 7C 08 'ord:prev' 7D 20 32 bytes E1 = 46
  const size = memosSize([
    { type: 'ord', data: new Uint8Array(962) },
    { type: 'ord:prev', data: new Uint8Array(32) },
  ])
  assert.equal(size, 972 + 46)
})

test('small content fits in a single reveal', () => {
  const plan = planInscription({ body: utf8('hello, ledger'), contentType: 'text/plain;charset=utf-8' })
  assert.equal(plan.chunks.length, 0)
  const tx = buildRevealTx(ACCOUNT, plan)
  assert.equal(tx.TransactionType, 'NFTokenMint')
  assert.equal(tx.Flags, 8)
  const envelope = parseEnvelope(tx)
  assert.equal(envelope?.kind, 'reveal')
  assert.equal(Buffer.from(envelope!.body).toString(), 'hello, ledger')
  assert.equal(envelope!.kind === 'reveal' && envelope.contentType, 'text/plain;charset=utf-8')
})

test('large content is split into chunks that each fit the memo limit exactly', () => {
  const body = randomBytes(50_000)
  const plan = planInscription({ body, contentType: 'image/png', metadata: { name: 'test' } }, { nft: false })
  assert.ok(plan.chunks.length > 40)
  assert.deepEqual(Buffer.concat([...plan.chunks, plan.revealBody]), body)

  let prev: string | undefined
  for (let i = 0; i < plan.chunks.length; i++) {
    const tx = buildChunkTx(ACCOUNT, plan, i, prev)
    assert.ok(memosSize(fromXrplMemos(tx.Memos)) <= MEMO_LIMIT)
    prev = HASH_A
  }
  const reveal = buildRevealTx(ACCOUNT, plan, HASH_A)
  assert.equal(reveal.TransactionType, 'AccountSet')
  assert.ok(memosSize(fromXrplMemos(reveal.Memos)) <= MEMO_LIMIT)

  // Chunks are as full as they can be: one more byte would not fit.
  const capacity = chunkCapacity()
  assert.equal(plan.chunks[0].length, capacity)
  assert.ok(memosSize([{ type: 'ord:chunk', data: new Uint8Array(capacity + 1) }, { type: 'ord:prev', data: new Uint8Array(32) }]) > MEMO_LIMIT)
})

test('chunked reveal carries sha256, length and prev', () => {
  const body = randomBytes(5000)
  const plan = planInscription({ body, contentType: 'application/octet-stream', contentEncoding: 'br' })
  const envelope = parseEnvelope(buildRevealTx(ACCOUNT, plan, HASH_A))
  assert.ok(envelope && envelope.kind === 'reveal')
  assert.equal(envelope.prev, HASH_A)
  assert.equal(envelope.sha256, sha256(body))
  assert.equal(envelope.length, 5000)
  assert.equal(envelope.contentEncoding, 'br')
})

test('content types are normalized for MemoFormat', () => {
  assert.equal(normalizeContentType('text/html; charset = utf-8'), 'text/html;charset=utf-8')
  assert.throws(() => normalizeContentType('text/plain "x"'))
  assert.throws(() => normalizeContentType(''))
})

test('malformed envelopes are rejected', () => {
  const memo = (type: string, data = '') => ({
    Memo: { MemoType: Buffer.from(type).toString('hex'), ...(data ? { MemoData: data } : {}) },
  })
  assert.equal(parseEnvelope({ Memos: [memo('something-else', 'AA')] }), null)
  assert.throws(() => parseEnvelope({ Memos: [memo('ord', 'AA'), memo('ord', 'BB')] }), EnvelopeError)
  assert.throws(() => parseEnvelope({ Memos: [memo('ord', 'AA'), memo('ord:prev', 'AABB')] }), EnvelopeError)
  assert.throws(() => parseEnvelope({ Memos: [memo('ord', 'AA'), memo('ord:prev', HASH_A)] }), /sha256/)
  assert.throws(() => parseEnvelope({ Memos: [memo('ord', 'AA'), memo('ord:len', Buffer.from('01').toString('hex'))] }), EnvelopeError)
})

test('inscription ids', () => {
  assert.equal(parseInscriptionId(`${'ab'.repeat(32)}i0`), 'AB'.repeat(32))
  assert.equal(parseInscriptionId('ab'.repeat(32)), 'AB'.repeat(32))
  assert.throws(() => parseInscriptionId('nope'))
})

test('plans reject oversized metadata and bad royalties', () => {
  assert.throws(() => planInscription({ body: utf8('x'), contentType: 'text/plain', metadata: 'm'.repeat(2000) }), /exceed/)
  assert.throws(() => planInscription({ body: utf8('x'), contentType: 'text/plain' }, { nft: { transferFee: 60000 } }))
})

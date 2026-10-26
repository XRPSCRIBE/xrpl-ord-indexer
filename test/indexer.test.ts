import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Wallet } from 'xrpl'
import { IndexRecord, runIndexer } from '../src/indexer.js'
import { utf8 } from '../src/memo.js'
import { buildChunkTx, buildRevealTx, planInscription, type InscriptionPlan } from '../src/protocol.js'
import { resolveInscription } from '../src/resolve.js'
import { MockLedger } from './mock-ledger.js'

/** Write an inscription the way any client would: chunks in order, then the reveal. */
async function inscribe(ledger: MockLedger, wallet: Wallet, plan: InscriptionPlan): Promise<string> {
  let prev: string | undefined
  let sequence = await ledger.nextSequence(wallet.classicAddress)
  const send = async (tx: Record<string, unknown>) => {
    const signed = wallet.sign({ ...tx, Fee: '10', Sequence: sequence++ } as any)
    await ledger.submit(signed.tx_blob)
    // Reading the validated ledger closes one, applying what was submitted.
    await ledger.validatedLedgerIndex()
    return signed.hash
  }
  for (let i = 0; i < plan.chunks.length; i++) prev = await send(buildChunkTx(wallet.classicAddress, plan, i, prev))
  return `${await send(buildRevealTx(wallet.classicAddress, plan, prev))}i0`
}

test('the indexer numbers inscriptions in ledger order and rebuilds their content', async () => {
  const ledger = new MockLedger()
  const wallet = Wallet.generate()
  ledger.fund(wallet.classicAddress)
  const from = ledger.ledger + 1
  const big = new Uint8Array(5000).map((_, i) => i % 251)
  const first = await inscribe(ledger, wallet, planInscription({ body: utf8('hello xrpl'), contentType: 'text/plain;charset=utf-8' }, { nft: false }))
  const second = await inscribe(ledger, wallet, planInscription({ body: big, contentType: 'application/octet-stream' }))
  // An unrelated transaction with no inscription memos is ignored.
  ledger.inject({ TransactionType: 'AccountSet', Account: wallet.classicAddress })
  const to = ledger.ledger
  const records: IndexRecord[] = []
  const finished: number[] = []
  await runIndexer({ source: ledger, from, to, onRecord: (r) => void records.push(r), onLedger: (l) => void finished.push(l) })
  assert.deepEqual(
    records.map((r) => [r.number, r.id, r.contentType, r.length, r.binding]),
    [
      [0, first, 'text/plain;charset=utf-8', 10, 'account'],
      [1, second, 'application/octet-stream', 5000, 'nft'],
    ],
  )
  assert.ok(records[1].chunks > 0 && records[1].nftokenId, 'a multi-chunk NFT inscription')
  assert.equal(finished.at(-1), to, 'every ledger up to the end is checkpointed')
  const rebuilt = await resolveInscription(ledger, second)
  assert.deepEqual(Buffer.from(rebuilt.body), Buffer.from(big))
})

test('numbering continues from an existing index', async () => {
  const ledger = new MockLedger()
  const wallet = Wallet.generate()
  ledger.fund(wallet.classicAddress)
  const from = ledger.ledger + 1
  await inscribe(ledger, wallet, planInscription({ body: utf8('gm'), contentType: 'text/plain' }, { nft: false }))
  const records: IndexRecord[] = []
  await runIndexer({ source: ledger, from, to: ledger.ledger, nextNumber: 41, onRecord: (r) => void records.push(r) })
  assert.deepEqual(records.map((r) => r.number), [41])
})

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LedgerTx } from '../src/client.js'
import { utf8 } from '../src/memo.js'
import type { Inscription } from '../src/resolve.js'
import { TokenFollower } from '../src/tokens.js'
import { Xrc20Log } from '../src/xrc20-log.js'

let n = 0
const hash = () => (++n).toString(16).padStart(64, '0').toUpperCase()

function inscription(inscriber: string, op: Record<string, string>, nftokenId?: string): Inscription {
  const revealHash = hash()
  const body = utf8(JSON.stringify({ p: 'xrc-20', ...op }))
  return { id: `${revealHash}i0`, revealHash, inscriber, binding: nftokenId ? 'nft' : 'account', nftokenId, contentType: 'text/plain;charset=utf-8', body, length: body.length, sha256: '', chunkHashes: [] }
}

const reveal = (i: Inscription, index: number): LedgerTx => ({ hash: i.revealHash, tx: { TransactionType: i.nftokenId ? 'NFTokenMint' : 'AccountSet', Account: i.inscriber }, meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: index }, validated: true })

/** An accepted sell offer: the NFT moves from `from` to `to`. */
function sale(nftokenId: string, from: string, to: string): LedgerTx {
  const offer = hash()
  return {
    hash: hash(),
    tx: { TransactionType: 'NFTokenAcceptOffer', Account: to, NFTokenSellOffer: offer },
    meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0, AffectedNodes: [{ DeletedNode: { LedgerEntryType: 'NFTokenOffer', LedgerIndex: offer, FinalFields: { Owner: from, NFTokenID: nftokenId, Amount: '10000000', Flags: 1 } } }] },
    validated: true,
  }
}

test('the token follower records operations in ledger order and moves transfers with their NFT', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'xrpl-ord-tokens-')), 'inscriptions.jsonl.xrc20.jsonl')
  const log = new Xrc20Log(path)
  const follow = new TokenFollower(log)
  const nft = 'AB'.repeat(32)
  const ops = [
    inscription('rDeployer', { op: 'deploy', tick: 'xogi', max: '100000000000', lim: '1000' }),
    inscription('rAlice', { op: 'mint', tick: 'xogi', amt: '1000' }),
    inscription('rAlice', { op: 'transfer', tick: 'xogi', amt: '250' }, nft),
  ]
  // One ledger: the indexer reports each inscription and its number, then the transactions.
  ops.forEach((i, k) => {
    follow.onInscription(i)
    follow.onRecord({ number: k, id: i.id } as any)
  })
  follow.onTransactions(100, ops.map((i, k) => reveal(i, k)))
  assert.deepEqual(log.ledger.balances('rAlice'), [{ tick: 'xogi', available: '750', transferable: '250', total: '1000' }])
  // The next ledger sells the transfer inscription to Bob: the 250 go with it, once.
  follow.onTransactions(101, [sale(nft, 'rAlice', 'rBob')])
  follow.onTransactions(102, [sale(nft, 'rBob', 'rCarol')])
  assert.deepEqual(log.ledger.balances('rBob'), [{ tick: 'xogi', available: '250', transferable: '0', total: '250' }])
  assert.deepEqual(log.ledger.balances('rCarol'), [])
  // The log replays to the same balances (a restart).
  const replay = new Xrc20Log(path).ledger
  assert.deepEqual(replay.balances('rAlice'), [{ tick: 'xogi', available: '750', transferable: '0', total: '750' }])
  assert.deepEqual(replay.token('xogi')?.holders, 2)
})

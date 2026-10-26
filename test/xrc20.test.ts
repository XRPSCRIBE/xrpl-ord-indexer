import assert from 'node:assert/strict'
import { test } from 'node:test'
import { utf8 } from '../src/memo.js'
import { Xrc20Event, Xrc20Ledger, fromUnits, parseXrc20, toUnits } from '../src/xrc20.js'

const json = (v: unknown) => utf8(JSON.stringify(v))

test('only well-formed xrc-20 JSON in plain text counts', () => {
  assert.deepEqual(parseXrc20('text/plain;charset=utf-8', json({ p: 'xrc-20', op: 'deploy', tick: 'XOGI', max: '100000000000', lim: '1000' })), { op: 'deploy', tick: 'xogi', max: '100000000000', lim: '1000' })
  assert.deepEqual(parseXrc20('application/json', json({ p: 'XRC-20', op: 'mint', tick: 'xogi', amt: '1000' })), { op: 'mint', tick: 'xogi', amt: '1000' })
  assert.equal(parseXrc20('text/html', json({ p: 'xrc-20', op: 'mint', tick: 'xogi', amt: '1' })), undefined)
  assert.equal(parseXrc20('text/plain', json({ p: 'brc-20', op: 'mint', tick: 'xogi', amt: '1' })), undefined)
  assert.equal(parseXrc20('text/plain', json({ p: 'xrc-20', op: 'mint', tick: 'xog', amt: '1' })), undefined, 'tickers are 4 characters')
  assert.equal(parseXrc20('text/plain', json({ p: 'xrc-20', op: 'mint', tick: 'xogi', amt: 1000 })), undefined, 'amounts are strings')
  assert.equal(parseXrc20('text/plain', json({ p: 'xrc-20', op: 'mint', tick: 'xogi', amt: '01' })), undefined)
  assert.equal(parseXrc20('text/plain', json({ p: 'xrc-20', op: 'burn', tick: 'xogi', amt: '1' })), undefined)
  assert.equal(parseXrc20('text/plain', json({ p: 'xrc-20', op: 'mint', tick: 'xogi', amt: '1' }), 'gzip'), undefined)
  assert.equal(parseXrc20('text/plain', utf8('not json')), undefined)
  assert.equal(toUnits('1.5', 2), 150n)
  assert.equal(toUnits('1.555', 2), undefined)
  assert.equal(fromUnits(150n, 2), '1.5')
  assert.equal(fromUnits(1000n * 10n ** 18n, 18), '1000')
})

let n = 0
const at = () => ({ hash: (++n).toString(16).padStart(64, '0').toUpperCase(), ledger: 10 + n, txIndex: 0 })
const inscription = (inscriber: string, op: any, nftokenId?: string): Xrc20Event => {
  const base = at()
  return { kind: 'inscription', ...base, id: `${base.hash}i0`, number: n, inscriber, nftokenId, op }
}

test('deploy, mint up to the limit, and the last mint takes what is left', () => {
  const x = new Xrc20Ledger()
  x.apply(inscription('rA', { op: 'mint', tick: 'xogi', amt: '10' }))
  assert.equal(x.balances('rA').length, 0, 'minting before the deploy counts for nothing')
  const deploy = inscription('rD', { op: 'deploy', tick: 'xogi', max: '2500', lim: '1000', dec: 0 })
  x.apply(deploy)
  const again = inscription('rE', { op: 'deploy', tick: 'xogi', max: '9', lim: '9' })
  x.apply(again)
  assert.equal(x.verdict((again as any).id)!.valid, false, 'the first deploy wins')
  x.apply(inscription('rA', { op: 'mint', tick: 'xogi', amt: '1000' }))
  const over = inscription('rA', { op: 'mint', tick: 'xogi', amt: '1001' })
  x.apply(over)
  assert.match(x.verdict((over as any).id)!.reason!, /mint limit/)
  x.apply(inscription('rB', { op: 'mint', tick: 'xogi', amt: '1000' }))
  const last = inscription('rB', { op: 'mint', tick: 'xogi', amt: '1000' })
  x.apply(last)
  assert.equal(x.verdict((last as any).id)!.credited, '500')
  const after = inscription('rC', { op: 'mint', tick: 'xogi', amt: '1' })
  x.apply(after)
  assert.match(x.verdict((after as any).id)!.reason!, /fully minted/)
  assert.deepEqual(x.token('XOGI'), { tick: 'xogi', max: '2500', lim: '1000', dec: 0, minted: '2500', mints: 3, holders: 2, deployer: 'rD', deployId: (deploy as any).id, deployNumber: (deploy as any).number })
  assert.deepEqual(x.holders('xogi').items.map((h) => [h.address, h.total]), [['rB', '1500'], ['rA', '1000']])
})

test('a transfer inscription sets the amount aside and moves it with the NFT, once', () => {
  const x = new Xrc20Ledger()
  x.apply(inscription('rD', { op: 'deploy', tick: 'xogi', max: '100000000000', lim: '1000' }))
  x.apply(inscription('rA', { op: 'mint', tick: 'xogi', amt: '1000' }))
  const tooMuch = inscription('rA', { op: 'transfer', tick: 'xogi', amt: '1001' }, 'N1')
  x.apply(tooMuch)
  assert.equal(x.verdict((tooMuch as any).id)!.valid, false)
  const noNft = inscription('rA', { op: 'transfer', tick: 'xogi', amt: '1' })
  x.apply(noNft)
  assert.match(x.verdict((noNft as any).id)!.reason!, /NFT/)
  const t = inscription('rA', { op: 'transfer', tick: 'xogi', amt: '250' }, 'N2')
  x.apply(t)
  assert.deepEqual(x.balances('rA'), [{ tick: 'xogi', available: '750', transferable: '250', total: '1000' }])
  assert.equal(x.isPending('n2'), true)
  assert.deepEqual(x.transferables('rA').map((p) => [p.amount, p.nftokenId]), [['250', 'N2']])
  x.apply({ kind: 'move', ...at(), nftokenId: 'N2', from: 'rA', to: 'rB' })
  assert.deepEqual(x.balances('rA'), [{ tick: 'xogi', available: '750', transferable: '0', total: '750' }])
  assert.deepEqual(x.balances('rB'), [{ tick: 'xogi', available: '250', transferable: '0', total: '250' }])
  assert.equal(x.verdict((t as any).id)!.state, 'spent')
  // Spent: moving the NFT on changes nothing.
  x.apply({ kind: 'move', ...at(), nftokenId: 'N2', from: 'rB', to: 'rC' })
  assert.equal(x.balances('rC').length, 0)
  // Burning an unspent transfer returns the amount.
  x.apply(inscription('rA', { op: 'transfer', tick: 'xogi', amt: '50' }, 'N3'))
  x.apply({ kind: 'burn', ...at(), nftokenId: 'N3' })
  assert.deepEqual(x.balances('rA'), [{ tick: 'xogi', available: '750', transferable: '0', total: '750' }])
  // The same event applied twice (a ledger re-read) counts once.
  const event = inscription('rA', { op: 'mint', tick: 'xogi', amt: '10' })
  assert.equal(x.apply(event), true)
  assert.equal(x.apply(event), false)
  assert.equal(x.balances('rA')[0].available, '760')
})

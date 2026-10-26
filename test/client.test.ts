import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConnectionError, DisconnectedError } from 'xrpl'
import { LedgerNotFoundError, XrplLedgerClient, proxyAgentFor, resolveNetwork } from '../src/client.js'

/** Replace the client's websocket connections with scripted fakes. */
function fake(endpoints: Array<(req: any) => any>) {
  const client = new XrplLedgerClient(endpoints.map((_, i) => `wss://node${i}.example`), { backoffMs: 0 })
  const calls: number[] = []
  ;(client as any).clients = endpoints.map((handler, i) => ({
    isConnected: () => true,
    request: async (req: any) => {
      calls.push(i)
      return { result: await handler(req) }
    },
  }))
  return { client, calls }
}

const rippledError = (error: string) => Object.assign(new Error(error), { data: { error } })

test('network names resolve to public endpoint lists', () => {
  assert.ok(resolveNetwork('mainnet').length > 1)
  assert.deepEqual(resolveNetwork('wss://a.example, wss://b.example'), ['wss://a.example', 'wss://b.example'])
})

test('rate-limited and disconnected endpoints fail over to the next one', async () => {
  const { client, calls } = fake([
    () => {
      throw rippledError('slowDown')
    },
    () => {
      throw new DisconnectedError('gone')
    },
    () => ({ drops: { base_fee: '10', open_ledger_fee: '12' } }),
  ])
  assert.deepEqual(await client.fee(), { base: 10, open: 12 })
  assert.deepEqual(calls, [0, 1, 2])
})

test('a server that names its rate-limit window is left alone until then', async () => {
  const quota = Object.assign(new Error('rate limit'), {
    data: { error: 'slowDown', error_message: 'rate limit: units quota (500000 per 3600s) exhausted, retry in ~1939604ms' },
  })
  const { client, calls } = fake([
    () => {
      throw quota
    },
    () => ({ drops: { base_fee: '10', open_ledger_fee: '10' } }),
  ])
  await client.fee()
  // Even when a request starts on it again, it is skipped while it rests.
  for (let i = 0; i < 2; i++) {
    ;(client as any).current = 0
    await client.fee()
  }
  assert.deepEqual(calls, [0, 1, 1, 1])
})

test('non-retryable errors are raised immediately', async () => {
  const { client, calls } = fake([
    () => {
      throw rippledError('actNotFound')
    },
    () => ({}),
  ])
  await assert.rejects(client.nextSequence('rX'), /actNotFound/)
  assert.deepEqual(calls, [0])
})

test('a transaction missing on one server is looked up on the others', async () => {
  const tx = { hash: 'AB'.repeat(32), tx_json: { Account: 'rX' }, meta: { TransactionResult: 'tesSUCCESS' }, validated: true, ledger_index: 5 }
  const { client } = fake([
    () => {
      throw rippledError('txnNotFound')
    },
    () => tx,
  ])
  const found = await client.getTx(tx.hash)
  assert.equal(found?.tx.Account, 'rX')
  assert.equal(found?.ledgerIndex, 5)

  const { client: none } = fake([
    () => {
      throw rippledError('txnNotFound')
    },
    () => {
      throw rippledError('txnNotFound')
    },
  ])
  assert.equal(await none.getTx(tx.hash), null)
})

test('a ledger missing on one server is read from another, and a clear error when none has it', async () => {
  const ledger = { ledger: { ledger_index: 9, close_time_iso: '2026-10-21T20:00:00Z', transactions: [{ hash: 'CD'.repeat(32), tx_json: { Account: 'rY' }, meta: { TransactionResult: 'tesSUCCESS', TransactionIndex: 0 } }] } }
  const { client } = fake([
    () => {
      throw rippledError('lgrNotFound')
    },
    () => ledger,
  ])
  const txs = await client.ledgerTransactions(9)
  assert.equal(txs[0].tx.Account, 'rY')
  assert.equal(txs[0].ledgerIndex, 9)

  const { client: none } = fake([
    () => {
      throw rippledError('lgrNotFound')
    },
    () => {
      throw rippledError('lgrNotFound')
    },
  ])
  await assert.rejects(none.ledgerTransactions(9), (err: unknown) => err instanceof LedgerNotFoundError && /full-history server/.test(err.message))
})

test('connect falls back to the next endpoint when one times out', async () => {
  const client = new XrplLedgerClient(['wss://slow.example', 'wss://down.example', 'wss://up.example'])
  const attempts: string[] = []
  const endpoint = (url: string, works: boolean) => {
    let connected = false
    return {
      url,
      isConnected: () => connected,
      connect: async () => {
        attempts.push(url)
        if (!works) throw new ConnectionError(`connect() timed out (${url})`)
        connected = true
      },
      request: async () => ({ result: { ledger_index: 7 } }),
    }
  }
  ;(client as any).clients = [endpoint('wss://slow.example', false), endpoint('wss://down.example', false), endpoint('wss://up.example', true)]
  await client.connect()
  assert.deepEqual(attempts, ['wss://slow.example', 'wss://down.example', 'wss://up.example'])
  assert.equal(client.url, 'wss://up.example')
  assert.equal(await client.validatedLedgerIndex(), 7)

  const dead = new XrplLedgerClient(['wss://a.example', 'wss://b.example'])
  ;(dead as any).clients = [endpoint('wss://a.example', false), endpoint('wss://b.example', false)]
  await assert.rejects(dead.connect(), /timed out \(wss:\/\/b\.example\)/)
})

test('concurrent NFT owner lookups find the Clio server without moving the shared endpoint', async () => {
  const notClio = () => {
    throw rippledError('unknownCmd')
  }
  const clio = (req: any) => (req.nft_id === 'BURNED' ? { is_burned: true, owner: 'rGone' } : req.nft_id === 'NONE' ? (() => { throw rippledError('objectNotFound') })() : { owner: `owner-of-${req.nft_id}` })
  const { client, calls } = fake([notClio, notClio, clio])
  const owners = await Promise.all(Array.from({ length: 20 }, (_, i) => client.nftOwner(`NFT${i}`)))
  assert.deepEqual(owners, Array.from({ length: 20 }, (_, i) => `owner-of-NFT${i}`))
  assert.equal(client.url, 'wss://node0.example', 'other requests still go to the first endpoint')
  calls.length = 0
  assert.equal(await client.nftOwner('NFT0'), 'owner-of-NFT0')
  assert.deepEqual(calls, [2], 'the endpoint that answered is asked first next time')
  assert.equal(await client.nftOwner('BURNED'), undefined)
  assert.equal(await client.nftOwner('NONE'), undefined)
  const { client: noClio } = fake([notClio, notClio])
  assert.equal(await noClio.nftOwner('NFT0'), undefined)
})

test('websocket connections go through HTTPS_PROXY unless NO_PROXY matches', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: 'localhost,.internal.example' }
  assert.ok(proxyAgentFor('wss://xrplcluster.com', env))
  assert.equal(proxyAgentFor('wss://node.internal.example:51233', env), undefined)
  assert.equal(proxyAgentFor('wss://xrplcluster.com', {}), undefined)
})

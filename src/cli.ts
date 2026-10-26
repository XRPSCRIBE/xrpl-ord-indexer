#!/usr/bin/env node
// xrpl-ord-index: find every inscription on the XRP Ledger, in order, and write one
// JSON line per inscription, plus every XRC-20 token operation to a token log.
// Resumable: the last finished ledger is kept in a cursor file next to the output.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { XrplLedgerClient } from './client.js'
import { IndexRecord, runIndexer } from './indexer.js'
import { backfillTokens, TokenFollower } from './tokens.js'
import { Xrc20Log } from './xrc20-log.js'

const USAGE = `Usage:
  xrpl-ord-index [--network N] [--from LEDGER | --resume] [--to LEDGER] [--prefetch N] [--out FILE]
  xrpl-ord-index tokens [--out FILE] [--tick TICK] [--address R]

Indexing writes one JSON line per inscription to FILE (default inscriptions.jsonl),
in inscription order; every XRC-20 token operation to FILE.xrc20.jsonl; and the
last fully indexed ledger to FILE.cursor.

"tokens" replays the token log and prints JSON: every token; one token with its
holders (--tick); or one account's balances (--address).

  --network N     mainnet, testnet (default), devnet, or wss:// URL(s), comma-separated
  --from LEDGER   start here (default: the latest validated ledger)
  --resume        start after the ledger in FILE.cursor
  --to LEDGER     stop after this ledger (default: keep following new ledgers)
  --prefetch N    ledgers fetched ahead in parallel, 1-64 (default 1; more for a catch-up)
  --out FILE      output file (default inscriptions.jsonl)

Reading old ledgers needs a full-history server, e.g. --network wss://xrplcluster.com
(mainnet) or wss://s.altnet.rippletest.net:51233 (testnet).
`

type Opts = { network: string; from?: string; to?: string; resume?: boolean; prefetch?: string; out: string; tick?: string; address?: string; help?: boolean }

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: 'string', default: 'testnet' },
      from: { type: 'string' },
      to: { type: 'string' },
      resume: { type: 'boolean' },
      prefetch: { type: 'string' },
      out: { type: 'string', default: 'inscriptions.jsonl' },
      tick: { type: 'string' },
      address: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const opts = values as Opts
  if (opts.help) return void process.stdout.write(USAGE)
  if (positionals[0] === 'tokens') return printTokens(opts)
  if (positionals.length) throw new Error(`unknown command "${positionals[0]}" (see --help)`)
  const client = new XrplLedgerClient(opts.network)
  await client.connect()
  try {
    // A long catch-up meets dropped connections and busy servers: wait, then resume from the cursor.
    let current = opts
    for (;;) {
      try {
        await indexToFile(client, current)
        break
      } catch (err) {
        console.error(`indexer: ${err instanceof Error ? err.message : String(err)}; resuming in 10 s`)
        current = { ...opts, from: undefined, resume: true }
        await new Promise((resolve) => setTimeout(resolve, 10_000))
      }
    }
  } finally {
    await client.disconnect()
  }
}

/** Append numbered inscriptions to opts.out, checkpointing each finished ledger in opts.out.cursor. */
async function indexToFile(client: XrplLedgerClient, opts: Opts): Promise<void> {
  const out = opts.out
  const cursorPath = `${out}.cursor`
  let nextNumber = 0
  if (existsSync(out)) {
    const lines = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean)
    if (lines.length) nextNumber = (JSON.parse(lines.at(-1)!) as IndexRecord).number + 1
  }
  let from: number
  if (opts.from) from = Number(opts.from)
  else if (opts.resume) {
    if (!existsSync(cursorPath)) throw new Error(`--resume: no cursor file ${cursorPath}`)
    from = Number(readFileSync(cursorPath, 'utf8')) + 1
  } else from = await client.validatedLedgerIndex()
  // Tokens: a new token log starts from the inscriptions already indexed.
  const tokens = new Xrc20Log(`${out}.xrc20.jsonl`)
  if (!tokens.exists) {
    const existing = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as IndexRecord) : []
    if (existing.length) console.error(`xrc-20: ${await backfillTokens(tokens, existing, client)} token operation(s) among ${existing.length} indexed inscriptions`)
    else tokens.touch()
  }
  const follower = new TokenFollower(tokens)
  console.error(`Indexing from ledger ${from}${opts.to ? ` to ${opts.to}` : ' (following)'} into ${out}`)
  await runIndexer({
    source: client,
    from,
    to: opts.to ? Number(opts.to) : undefined,
    nextNumber,
    prefetch: opts.prefetch ? Math.max(1, Math.min(64, Number(opts.prefetch))) : 1,
    onInscription: (inscription) => follower.onInscription(inscription),
    onRecord: (record) => {
      appendFileSync(out, JSON.stringify(record) + '\n')
      follower.onRecord(record)
      console.error(`#${record.number} ${record.id} ${record.contentType} ${record.length}B`)
    },
    onInvalid: (hash, reason) => console.error(`skipped ${hash}: ${reason}`),
    onTransactions: (ledger, txs) => follower.onTransactions(ledger, txs),
    onLedger: (ledger) => writeFileSync(cursorPath, String(ledger)),
  })
}

/** Replay the token log and print tokens, one token's holders, or one account's balances. */
function printTokens(opts: Opts): void {
  const path = `${opts.out}.xrc20.jsonl`
  if (!existsSync(path)) throw new Error(`no token log ${path}: run the indexer first`)
  const x = new Xrc20Log(path).ledger
  const show = (value: unknown): void => void process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  if (opts.address) return show({ address: opts.address, balances: x.balances(opts.address), transferables: x.transferables(opts.address) })
  if (opts.tick) {
    const token = x.token(opts.tick)
    if (!token) throw new Error(`no token ${opts.tick} in ${path}`)
    return show({ ...token, holders: x.holders(opts.tick, 1, 1000).items, activity: x.activity(opts.tick, 50) })
  }
  show(x.list())
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

# xrpl-ord-indexer

An indexer for **XRPL inscriptions**: files stored entirely on the XRP Ledger, in transaction memos, under the `ord` protocol (see [SPEC.md](SPEC.md)). It reads validated ledgers in order, finds every valid inscription, rebuilds its content from its chain of chunk transactions, checks it against its declared length and SHA-256, and numbers it.

This is the indexer that powers [XRPSCRIBE](https://xrpscribe.com). Anyone can run it and get the same inscription numbers.

## Install

```sh
git clone https://github.com/reallyshadydev/xrpl-ord-indexer.git
cd xrpl-ord-indexer
npm install
npm run build
```

Node.js 20 or newer.

## Run it

```sh
# Follow testnet from the latest ledger
node dist/cli.js --network testnet

# Index a range of mainnet history, eight ledgers fetched at a time
node dist/cli.js --network wss://xrplcluster.com --from 90000000 --to 90100000 --prefetch 8 --out mainnet.jsonl

# Carry on after the last finished ledger
node dist/cli.js --network mainnet --resume --out mainnet.jsonl
```

| Option | Meaning |
|---|---|
| `--network N` | `mainnet`, `testnet` (default), `devnet`, or `wss://` URL(s), comma-separated. Public servers with automatic failover; no node of your own needed. |
| `--from LEDGER` | Start here. Default: the latest validated ledger. |
| `--resume` | Start after the ledger in `<out>.cursor`. |
| `--to LEDGER` | Stop after this ledger. Default: keep following new ledgers. |
| `--prefetch N` | Ledgers fetched ahead in parallel (1–64). They are still processed in order. Use more for a catch-up over history. |
| `--out FILE` | Output file. Default `inscriptions.jsonl`. |

Old ledgers and chunk transactions need a **full-history** server (for example `wss://xrplcluster.com` on mainnet). Dropped connections and busy servers are retried; after an error the indexer waits and resumes from its cursor.

## Output

One JSON object per line, in inscription order, and the last fully indexed ledger in `<out>.cursor`:

```json
{"number":84,"id":"60AC…EFBB0i0","ledgerIndex":21764325,"txIndex":8,"inscriber":"rQHv…ZpT","binding":"account","contentType":"text/plain;charset=utf-8","length":76,"sha256":"…","chunks":0,"feeDrops":"10","closeTime":"2026-10-23T16:16:51Z"}
```

| Field | Meaning |
|---|---|
| `number` | Inscription number: valid reveals in ledger order, then transaction order within a ledger. |
| `id` | Inscription ID: the reveal transaction hash plus `i0`. |
| `inscriber` | The account that signed the reveal. |
| `binding` | `nft` when the reveal minted an NFToken (whoever holds it owns the inscription), else `account`. |
| `nftokenId` | The NFToken, for `nft` bindings. |
| `contentType`, `contentEncoding` | As declared in the reveal. |
| `length`, `sha256` | Of the stored body, checked against the reveal's declarations. |
| `chunks` | Chunk transactions before the reveal. |
| `feeDrops` | Network fees of the reveal and its chunks: what it cost to put on chain. |

## As a library

```ts
import { XrplLedgerClient, runIndexer, resolveInscription } from 'xrpl-ord-indexer'

const client = new XrplLedgerClient('testnet')
await client.connect()

// Every inscription in a range of ledgers
await runIndexer({
  source: client,
  from: 21764320,
  to: 21764340,
  onRecord: (record) => console.log(record.number, record.id, record.contentType),
})

// One inscription's content, rebuilt from the ledger
const inscription = await resolveInscription(client, '60AC4E432598C981E130A281C5F5D42FB10BC5E9D88AE23D0D49E4CD516EFBB0i0')
console.log(inscription.contentType, inscription.body.length)
await client.disconnect()
```

`runIndexer` also accepts `onInscription` (the full inscription, body included), `onTransactions` (every transaction of each ledger) and `onLedger` (after each finished ledger, for checkpointing).

## Tests

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).

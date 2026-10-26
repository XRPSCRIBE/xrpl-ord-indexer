# XRPL Inscriptions (`ord`) — protocol v0

Inscriptions store arbitrary bytes (images, HTML, text, audio, anything) **directly on the XRP Ledger**, with no IPFS or other off-chain storage. The design follows Bitcoin Ordinals' inscriptions and keeps the `ord` signifier, adapted to how XRPL works.

## Where the data lives

Every XRPL transaction may carry a `Memos` array, and each memo has three hex fields: `MemoType`, `MemoData` and `MemoFormat`. rippled enforces these rules (`isMemoOkay`, `src/libxrpl/protocol/STTx.cpp`):

- The serialized `Memos` array can be at most **1024 bytes** per transaction, counting field headers and length prefixes.
- `MemoType` and `MemoFormat` may contain only RFC 3986 URL characters: `A–Z a–z 0–9 -._~:/?#[]@!$&'()*+,;=%`. Spaces are not allowed.
- `MemoData` is arbitrary bytes.

Content bigger than one transaction can carry is split into a **backward-linked chain** of transactions, the same way Bitcoin inscriptions push data in 520-byte pieces.

## Memo types

All ASCII. A transaction may carry other, unrelated memos, which are ignored.

| MemoType     | MemoData                                     | Used in        |
|--------------|----------------------------------------------|----------------|
| `ord`        | body bytes (the final piece). `MemoFormat` = content type | reveal |
| `ord:chunk`  | body bytes                                   | chunk          |
| `ord:prev`   | 32-byte hash of the previous chunk transaction | chunk, reveal |
| `ord:sha256` | 32-byte SHA-256 of the complete stored body  | reveal         |
| `ord:len`    | complete stored body length, ASCII decimal   | reveal         |
| `ord:enc`    | content encoding, e.g. `br`, `gzip` (ASCII)  | reveal         |
| `ord:meta`   | JSON metadata (UTF-8)                        | reveal         |

A transaction carries each type at most once. Unknown `ord:*` types are ignored, so new types can be added later without breaking older readers.

## Transactions

**Chunk transaction.** Carries `ord:chunk` and, for every chunk except the first, `ord:prev`. The reference implementation uses a no-op `AccountSet`, so the only cost is the transaction fee.

**Reveal transaction.** Carries `ord` and defines the inscription. When chunks exist it must also carry `ord:prev` (the last chunk), `ord:sha256` and `ord:len`.

- If the reveal is an **`NFTokenMint`**, the inscription is *bound* to the NFToken minted by that transaction. Whoever holds that NFToken owns the inscription, and it can be traded on any XRPL NFT marketplace or the native NFT offers. This plays the role of "inscriptions live on sats". The default NFToken URI is `ord:sha256:<hex>`.
- With any other transaction type, the inscription is *unbound* and belongs to the inscribing account.

The body is `chunk₁ ‖ chunk₂ ‖ … ‖ chunkₙ ‖ reveal body`, where `chunk₁` is the one without `ord:prev`.

## Identity and numbering

- **Inscription ID:** `<REVEAL_TX_HASH>i0`, mirroring ord's `<txid>i<index>`.
- **Inscription number:** indexers number valid inscriptions from 0, ordered by reveal ledger index and then `TransactionIndex`. Numbers are per network, and each indexer starts at the ledger it was told to start from.

## Validity

A reveal is a valid inscription when all of the following hold:

1. It is in a validated ledger with result `tesSUCCESS`.
2. It carries exactly one `ord` memo and a well-formed set of `ord:*` memos (hashes are 32 bytes, `ord:len` is canonical decimal, `ord:meta` is JSON).
3. If it has `ord:prev`, walking the chain reaches a chunk with no `ord:prev`. Every linked transaction must be validated, `tesSUCCESS`, sent by the **same account** as the reveal, and carry an `ord:chunk` memo.
4. The reassembled body's length equals `ord:len`, and its SHA-256 equals `ord:sha256` whenever that memo is present.

Readers should stop walking as soon as the bytes collected exceed `ord:len`.

## Writing safely

Each transaction's hash depends on its signed fields, and each chunk embeds the previous hash. A writer must therefore sign chunk *k+1* only after chunk *k*'s hash is final. A writer must also not reuse a Sequence while an earlier transaction that used it could still validate. The reference implementation:

- submits up to 8 transactions per round,
- sets `LastLedgerSequence` on every transaction,
- waits until each transaction has either validated or expired,
- then re-signs from the first failure,
- and sends the reveal alone, after the whole chain is validated.

Because links only point backwards, any validated prefix of the chain stays usable, so an interrupted upload can resume where it stopped.

## Retrieval and history

Memos are part of **transaction history**, not ledger state. Every validated ledger's transactions are hash-chained into the ledger header, so inscriptions are as tamper-evident as any other XRPL transaction. However, many servers prune old history, so reading old inscriptions needs a full-history server or Clio (for example `xrplcluster.com` or `s2.ripple.com`). This is the main way XRPL differs from Bitcoin, where every unpruned full node keeps every block.

## Recursion

Gateways serve bodies at `/content/<id>`, so an HTML or SVG inscription can load other inscriptions by path, as in ord's recursive inscriptions.

## Not in v0

Not yet specified: parent/child provenance, delegates, and multiple inscriptions per reveal (`i1`, `i2`, …). These can be added as new `ord:*` memo types later.

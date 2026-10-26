// The XRC-20 token indexer, fed by the inscription indexer: token operations are
// inscriptions, and transfer inscriptions are NFTs whose first move carries their
// tokens. Everything is recorded in ledger order in an event log (Xrc20Log), and
// balances are a replay of that log.
import type { LedgerReader, LedgerTx } from './client.js'
import type { IndexRecord } from './indexer.js'
import { transfersFromTx } from './nft-transfers.js'
import { resolveInscription, type Inscription } from './resolve.js'
import { parseXrc20 } from './xrc20.js'
import type { Xrc20Log } from './xrc20-log.js'

/**
 * Follows the inscription indexer: hand it each inscription (onInscription), its
 * number (onRecord) and then each ledger's transactions (onTransactions).
 */
export class TokenFollower {
  /** Inscriptions revealed in the ledger being processed, by reveal hash. */
  private readonly revealed = new Map<string, { inscription: Inscription; number?: number }>()

  constructor(private readonly log: Xrc20Log) {}

  onInscription(inscription: Inscription): void {
    this.revealed.set(inscription.revealHash.toUpperCase(), { inscription })
  }

  onRecord(record: IndexRecord): void {
    const seen = this.revealed.get(record.id.slice(0, 64).toUpperCase())
    if (seen) seen.number = record.number
  }

  /** One validated ledger, in transaction order. */
  onTransactions(ledger: number, txs: LedgerTx[]): void {
    for (const t of [...txs].sort((a, b) => (a.meta?.TransactionIndex ?? 0) - (b.meta?.TransactionIndex ?? 0))) {
      const base = { hash: t.hash, ledger, txIndex: t.meta?.TransactionIndex ?? 0, time: t.closeTime }
      const seen = this.revealed.get(t.hash.toUpperCase())
      if (seen) {
        const { inscription, number } = seen
        const op = parseXrc20(inscription.contentType, inscription.body, inscription.contentEncoding)
        if (op) this.log.record({ kind: 'inscription', ...base, id: inscription.id, number: number ?? -1, inscriber: inscription.inscriber, nftokenId: inscription.nftokenId, op })
      }
      for (const move of transfersFromTx(t)) if (this.log.ledger.isPending(move.nftokenId)) this.log.record({ kind: 'move', ...base, ...move })
      if (t.tx.TransactionType === 'NFTokenBurn' && t.meta?.TransactionResult === 'tesSUCCESS' && typeof t.tx.NFTokenID === 'string' && this.log.ledger.isPending(t.tx.NFTokenID)) {
        this.log.record({ kind: 'burn', ...base, nftokenId: t.tx.NFTokenID.toUpperCase() })
      }
    }
    this.revealed.clear()
  }
}

/**
 * Start a token log from an existing inscription index: records every token
 * operation among its inscriptions. Transfers moved before now are not seen, so
 * index tokens together with inscriptions from the start when you can.
 */
export async function backfillTokens(log: Xrc20Log, records: IndexRecord[], reader: LedgerReader): Promise<number> {
  let found = 0
  for (const record of [...records].sort((a, b) => a.number - b.number)) {
    if (record.contentEncoding || record.length > 1024 || !/^(text\/plain|application\/json)/i.test(record.contentType)) continue
    const inscription = await resolveInscription(reader, record.id).catch(() => undefined)
    const op = inscription && parseXrc20(inscription.contentType, inscription.body, inscription.contentEncoding)
    if (!op) continue
    log.record({ kind: 'inscription', hash: record.id.slice(0, 64), ledger: record.ledgerIndex, txIndex: record.txIndex, time: record.closeTime, id: record.id, number: record.number, inscriber: record.inscriber, nftokenId: record.nftokenId, op })
    found++
  }
  log.touch()
  return found
}

import { LedgerReader, LedgerTx } from './client.js'
import { toHex, utf8 } from './memo.js'
import { MEMO_TYPES } from './protocol.js'
import { Inscription, InscriptionError, inscriptionFromTx } from './resolve.js'

export interface IndexSource extends LedgerReader {
  validatedLedgerIndex(): Promise<number>
  ledgerTransactions(ledgerIndex: number): Promise<LedgerTx[]>
}

export interface IndexRecord {
  /** Sequential inscription number: valid reveals in ledger order, then transaction order. */
  number: number
  id: string
  ledgerIndex: number
  txIndex: number
  inscriber: string
  binding: 'nft' | 'account'
  nftokenId?: string
  contentType: string
  contentEncoding?: string
  length: number
  sha256: string
  chunks: number
  /** Network fees of the reveal and its chunks, in drops. */
  feeDrops?: string
  closeTime?: string
}

export interface IndexOptions {
  source: IndexSource
  from: number
  /** Last ledger to index; omit to follow new ledgers forever. */
  to?: number
  /** Number given to the first inscription found (continue an existing index). */
  nextNumber?: number
  onRecord: (record: IndexRecord) => void | Promise<void>
  /** The whole inscription, body included, just before its record (e.g. to keep the file). */
  onInscription?: (inscription: Inscription) => void | Promise<void>
  onInvalid?: (hash: string, reason: string) => void
  /** Every transaction of each ledger, after its inscriptions were reported (e.g. to follow NFT trades). */
  onTransactions?: (ledgerIndex: number, txs: LedgerTx[]) => void | Promise<void>
  /** Called after each ledger is fully indexed, e.g. to checkpoint. */
  onLedger?: (ledgerIndex: number) => void | Promise<void>
  pollMs?: number
  signal?: AbortSignal
  /** Ledgers fetched ahead in parallel (they are still processed in order). Default 1. */
  prefetch?: number
}

const BODY_TYPE_HEX = toHex(utf8(MEMO_TYPES.body))

/** Cheap pre-filter: does the transaction carry an `ord` body memo? */
export function isRevealCandidate(t: LedgerTx): boolean {
  if (t.meta?.TransactionResult !== 'tesSUCCESS' || !Array.isArray(t.tx.Memos)) return false
  return t.tx.Memos.some((m: any) => String(m?.Memo?.MemoType ?? '').toUpperCase() === BODY_TYPE_HEX)
}

/** Scan validated ledgers in order and report every valid inscription with its number. */
export async function runIndexer(options: IndexOptions): Promise<number> {
  const { source } = options
  const pollMs = options.pollMs ?? 3000
  let number = options.nextNumber ?? 0
  let ledger = options.from
  const prefetch = Math.max(1, options.prefetch ?? 1)
  // Ledgers requested ahead of the one being processed; numbering still follows ledger order.
  const ahead = new Map<number, Promise<LedgerTx[]>>()
  let validated = -1

  while (!options.signal?.aborted && (options.to === undefined || ledger <= options.to)) {
    if (ledger > validated) validated = await source.validatedLedgerIndex()
    if (ledger > validated) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }
    const last = Math.min(validated, ledger + prefetch - 1, options.to ?? Infinity)
    for (let n = ledger; n <= last; n++) {
      if (!ahead.has(n)) {
        const request = source.ledgerTransactions(n)
        request.catch(() => undefined) // reported when awaited, in order
        ahead.set(n, request)
      }
    }
    const pending = ahead.get(ledger)!
    ahead.delete(ledger)
    const txs = await pending
    for (const t of txs) {
      if (!isRevealCandidate(t)) continue
      try {
        const inscription = await inscriptionFromTx(source, t)
        await options.onInscription?.(inscription)
        await options.onRecord({
          number: number++,
          id: inscription.id,
          ledgerIndex: ledger,
          txIndex: t.meta?.TransactionIndex ?? 0,
          inscriber: inscription.inscriber,
          binding: inscription.binding,
          nftokenId: inscription.nftokenId,
          contentType: inscription.contentType,
          contentEncoding: inscription.contentEncoding,
          length: inscription.length,
          sha256: inscription.sha256,
          chunks: inscription.chunkHashes.length,
          feeDrops: inscription.feeDrops,
          closeTime: t.closeTime,
        })
      } catch (err) {
        if (!(err instanceof InscriptionError) || err.code === 'not_found') throw err
        options.onInvalid?.(t.hash, err.message)
      }
    }
    await options.onTransactions?.(ledger, txs)
    await options.onLedger?.(ledger)
    ledger++
  }
  return number
}

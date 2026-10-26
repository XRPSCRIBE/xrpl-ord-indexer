import { createHash } from 'node:crypto'
import { decode, hashes } from 'xrpl'
import type { LedgerClient, LedgerTx } from '../src/client.js'
import type { IndexSource } from '../src/indexer.js'
import { MEMO_LIMIT, fromXrplMemos, isUrlSafe, memosSize } from '../src/memo.js'

interface Stored {
  hash: string
  tx: Record<string, any>
  meta?: Record<string, any>
  ledgerIndex?: number
}

/**
 * In-memory stand-in for rippled. Applies the memo checks rippled performs,
 * enforces Sequence and LastLedgerSequence, and closes one ledger every time
 * the validated ledger index is read.
 */
export class MockLedger implements LedgerClient, IndexSource {
  ledger = 1000
  submitted = 0
  private readonly sequences = new Map<string, number>()
  private readonly open: Stored[] = []
  private readonly txs = new Map<string, Stored>()
  private readonly ledgers = new Map<number, Stored[]>()
  /** Zero-based submission numbers to accept but silently lose (never validated). */
  readonly lose = new Set<number>()
  /** Like a busy rippled: turn away (telCAN_NOT_QUEUE) anything beyond this many open transactions. */
  busyAfter?: number

  fund(account: string, sequence = 1): void {
    this.sequences.set(account, sequence)
  }

  async getTx(hash: string): Promise<LedgerTx | null> {
    const stored = this.txs.get(hash.toUpperCase())
    if (!stored) return null
    return {
      hash: stored.hash,
      tx: stored.tx,
      meta: stored.meta,
      validated: stored.ledgerIndex !== undefined,
      ledgerIndex: stored.ledgerIndex,
    }
  }

  async nextSequence(account: string): Promise<number> {
    const base = this.sequences.get(account)
    if (base === undefined) throw new Error('actNotFound')
    let next = base
    while (this.open.some((s) => s.tx.Account === account && s.tx.Sequence === next)) next++
    return next
  }

  async validatedLedgerIndex(): Promise<number> {
    this.close()
    return this.ledger
  }

  async fee(): Promise<{ base: number; open: number }> {
    return { base: 10, open: 10 }
  }

  async submit(txBlob: string): Promise<string> {
    const n = this.submitted++
    const tx = decode(txBlob) as Record<string, any>
    const hash = hashes.hashSignedTx(txBlob)
    if (tx.Memos) {
      if (memosSize(fromXrplMemos(tx.Memos)) > MEMO_LIMIT) return 'temINVALID'
      for (const memo of fromXrplMemos(tx.Memos)) {
        if (!isUrlSafe(memo.type) || (memo.format !== undefined && !isUrlSafe(memo.format))) return 'temINVALID'
      }
    }
    const expected = this.sequences.get(tx.Account)
    if (expected === undefined) return 'terNO_ACCOUNT'
    if (tx.Sequence < expected) return 'tefPAST_SEQ'
    if (this.lose.has(n)) return 'tesSUCCESS'
    if (this.busyAfter !== undefined && this.open.length >= this.busyAfter) return 'telCAN_NOT_QUEUE'
    const stored: Stored = { hash, tx }
    this.open.push(stored)
    this.txs.set(hash, stored)
    return tx.Sequence < (await this.nextSequence(tx.Account)) ? 'tesSUCCESS' : 'terPRE_SEQ'
  }

  async ledgerTransactions(ledgerIndex: number): Promise<LedgerTx[]> {
    return (this.ledgers.get(ledgerIndex) ?? []).map((s) => ({
      hash: s.hash,
      tx: s.tx,
      meta: s.meta,
      validated: true,
      ledgerIndex,
    }))
  }

  /** Put an arbitrary (unsigned) transaction straight into the next ledger. */
  inject(tx: Record<string, any>, result = 'tesSUCCESS'): string {
    const hash = createHash('sha256').update(JSON.stringify(tx) + Math.random()).digest('hex').toUpperCase()
    this.ledger++
    const stored: Stored = { hash, tx, meta: { TransactionResult: result, TransactionIndex: 0 }, ledgerIndex: this.ledger }
    this.txs.set(hash, stored)
    this.ledgers.set(this.ledger, [stored])
    return hash
  }

  private close(): void {
    this.ledger++
    const applied: Stored[] = []
    let progress = true
    while (progress) {
      progress = false
      for (const s of [...this.open]) {
        const account = s.tx.Account
        if (s.tx.LastLedgerSequence !== undefined && this.ledger > s.tx.LastLedgerSequence) {
          this.open.splice(this.open.indexOf(s), 1)
          this.txs.delete(s.hash)
          continue
        }
        if (s.tx.Sequence !== this.sequences.get(account)) continue
        this.open.splice(this.open.indexOf(s), 1)
        this.sequences.set(account, s.tx.Sequence + 1)
        s.ledgerIndex = this.ledger
        s.meta = { TransactionResult: 'tesSUCCESS', TransactionIndex: applied.length }
        if (s.tx.TransactionType === 'NFTokenMint') {
          s.meta.nftoken_id = createHash('sha256').update(s.hash).digest('hex').toUpperCase()
        }
        applied.push(s)
        progress = true
      }
    }
    this.ledgers.set(this.ledger, applied)
  }
}

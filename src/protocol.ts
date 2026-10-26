import { createHash } from 'node:crypto'
import { MEMO_LIMIT, Memo, fromHex, fromUtf8, fromXrplMemos, isUrlSafe, maxDataBytes, toHex, toXrplMemos, utf8 } from './memo.js'

/** MemoType values defined by the protocol. See SPEC.md. */
export const MEMO_TYPES = {
  /** Inscription body (in the reveal transaction). MemoFormat carries the content type. */
  body: 'ord',
  /** Body bytes carried by a chunk transaction. */
  chunk: 'ord:chunk',
  /** 32-byte hash of the previous chunk transaction. */
  prev: 'ord:prev',
  /** 32-byte SHA-256 of the complete stored body. */
  sha256: 'ord:sha256',
  /** Length of the complete stored body, as ASCII decimal. */
  len: 'ord:len',
  /** Content encoding of the body, e.g. "br" or "gzip". */
  enc: 'ord:enc',
  /** Arbitrary JSON metadata. */
  meta: 'ord:meta',
} as const

/** NFTokenMint flag that lets the token be transferred between accounts. */
export const TF_TRANSFERABLE = 0x00000008

const HASH_BYTES = 32

export interface InscriptionInput {
  /** The bytes stored on-chain (already compressed, if contentEncoding is set). */
  body: Uint8Array
  /** MIME type, e.g. "image/png" or "text/html;charset=utf-8". */
  contentType: string
  /** Content encoding applied to body, e.g. "br". */
  contentEncoding?: string
  /** JSON-serializable metadata stored with the inscription. */
  metadata?: unknown
}

export interface NftOptions {
  taxon?: number
  transferable?: boolean
  /** NFToken URI. Defaults to "ord:sha256:<hex>". */
  uri?: string
  /** Royalty in units of 1/100,000 (0-50000). Requires transferable. */
  transferFee?: number
}

export interface PlanOptions {
  /** Bind the inscription to an NFToken minted by the reveal (default) or not (false). */
  nft?: NftOptions | false
  /** Override the memo size limit (only useful if rippled ever raises it). */
  memoLimit?: number
}

export interface InscriptionPlan {
  contentType: string
  contentEncoding?: string
  metadata?: unknown
  sha256: string
  length: number
  /** Body bytes for each chunk transaction, in chain order. Empty for single-transaction inscriptions. */
  chunks: Uint8Array[]
  /** Body bytes carried by the reveal transaction (the final piece of the body). */
  revealBody: Uint8Array
  nft: NftOptions | false
  memoLimit: number
}

export type UnsignedTx = Record<string, unknown> & { TransactionType: string; Account: string }

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

/** Normalize a content type into a MemoFormat-safe string (no spaces). */
export function normalizeContentType(contentType: string): string {
  const normalized = contentType.trim().replace(/\s*;\s*/g, ';').replace(/\s*=\s*/g, '=')
  if (!normalized) throw new Error('content type is required')
  if (!isUrlSafe(normalized)) {
    throw new Error(`content type "${contentType}" contains characters not allowed in MemoFormat`)
  }
  return normalized
}

function headerMemos(input: { contentEncoding?: string; metadata?: unknown }): Memo[] {
  const memos: Memo[] = []
  if (input.contentEncoding) memos.push({ type: MEMO_TYPES.enc, data: utf8(input.contentEncoding) })
  if (input.metadata !== undefined) memos.push({ type: MEMO_TYPES.meta, data: utf8(JSON.stringify(input.metadata)) })
  return memos
}

function revealMemoList(
  plan: Pick<InscriptionPlan, 'contentType' | 'contentEncoding' | 'metadata' | 'sha256' | 'length'>,
  body: Uint8Array,
  prev: string | undefined,
): Memo[] {
  const memos: Memo[] = [{ type: MEMO_TYPES.body, data: body, format: plan.contentType }]
  if (prev !== undefined) {
    memos.push({ type: MEMO_TYPES.prev, data: hashBytes(prev) })
    memos.push({ type: MEMO_TYPES.sha256, data: hashBytes(plan.sha256) })
    memos.push({ type: MEMO_TYPES.len, data: utf8(String(plan.length)) })
  }
  return memos.concat(headerMemos(plan))
}

function chunkMemoList(data: Uint8Array, prev: string | undefined): Memo[] {
  const memos: Memo[] = [{ type: MEMO_TYPES.chunk, data }]
  if (prev !== undefined) memos.push({ type: MEMO_TYPES.prev, data: hashBytes(prev) })
  return memos
}

function hashBytes(hash: string): Uint8Array {
  if (!/^[0-9A-Fa-f]{64}$/.test(hash)) throw new Error(`invalid 32-byte hash: ${hash}`)
  return fromHex(hash)
}

const PLACEHOLDER_HASH = '00'.repeat(HASH_BYTES)

/** Number of body bytes one chunk transaction can carry under `memoLimit`. */
export function chunkCapacity(memoLimit = MEMO_LIMIT): number {
  return maxDataBytes((n) => chunkMemoList(new Uint8Array(n), PLACEHOLDER_HASH), memoLimit)
}

/** Split an inscription into the chunk and reveal payloads that fit rippled's memo limit. */
export function planInscription(input: InscriptionInput, options: PlanOptions = {}): InscriptionPlan {
  const memoLimit = options.memoLimit ?? MEMO_LIMIT
  const contentType = normalizeContentType(input.contentType)
  if (input.contentEncoding !== undefined && !/^[A-Za-z0-9._-]+$/.test(input.contentEncoding)) {
    throw new Error(`invalid content encoding "${input.contentEncoding}"`)
  }
  const body = input.body
  const base = {
    contentType,
    contentEncoding: input.contentEncoding,
    metadata: input.metadata,
    sha256: sha256(body),
    length: body.length,
  }
  const nft = options.nft === undefined ? {} : options.nft
  if (nft && nft.transferFee !== undefined) {
    if (!Number.isInteger(nft.transferFee) || nft.transferFee < 0 || nft.transferFee > 50000) {
      throw new Error('transferFee must be an integer between 0 and 50000')
    }
    if (nft.transferable === false && nft.transferFee > 0) throw new Error('transferFee requires a transferable NFT')
  }

  const singleCapacity = maxDataBytes((n) => revealMemoList(base, new Uint8Array(n), undefined), memoLimit)
  if (singleCapacity < 0) throw new Error('content type and metadata alone exceed the memo limit')
  if (body.length <= singleCapacity) {
    return { ...base, chunks: [], revealBody: body, nft, memoLimit }
  }

  const revealCapacity = maxDataBytes((n) => revealMemoList(base, new Uint8Array(n), PLACEHOLDER_HASH), memoLimit)
  if (revealCapacity < 0) throw new Error('content type and metadata alone exceed the memo limit')
  const perChunk = chunkCapacity(memoLimit)
  const chunked = body.length - revealCapacity
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < chunked; offset += perChunk) {
    chunks.push(body.subarray(offset, Math.min(offset + perChunk, chunked)))
  }
  return { ...base, chunks, revealBody: body.subarray(chunked), nft, memoLimit }
}

/** Total transactions (chunks + reveal) needed for a plan. */
export function transactionCount(plan: InscriptionPlan): number {
  return plan.chunks.length + 1
}

/**
 * Chunk transaction `index` of the plan. `prev` is the hash of chunk `index - 1`
 * and must be omitted for the first chunk.
 */
export function buildChunkTx(account: string, plan: InscriptionPlan, index: number, prev?: string): UnsignedTx {
  if (index < 0 || index >= plan.chunks.length) throw new Error(`chunk index ${index} out of range`)
  if ((index === 0) !== (prev === undefined)) throw new Error('prev is required for every chunk except the first')
  return {
    TransactionType: 'AccountSet',
    Account: account,
    Memos: toXrplMemos(chunkMemoList(plan.chunks[index], prev)),
  }
}

/** The reveal transaction. `prev` is the hash of the last chunk (omit when there are no chunks). */
export function buildRevealTx(account: string, plan: InscriptionPlan, prev?: string): UnsignedTx {
  if ((plan.chunks.length === 0) !== (prev === undefined)) {
    throw new Error('prev must be the last chunk hash exactly when the plan has chunks')
  }
  const memos = toXrplMemos(revealMemoList(plan, plan.revealBody, prev))
  if (!plan.nft) return { TransactionType: 'AccountSet', Account: account, Memos: memos }

  const nft = plan.nft
  const transferable = nft.transferable ?? true
  const tx: UnsignedTx = {
    TransactionType: 'NFTokenMint',
    Account: account,
    NFTokenTaxon: nft.taxon ?? 0,
    Flags: transferable ? TF_TRANSFERABLE : 0,
    URI: toHex(utf8(nft.uri ?? `ord:sha256:${plan.sha256.toLowerCase()}`)),
    Memos: memos,
  }
  if (nft.transferFee) tx.TransferFee = nft.transferFee
  return tx
}

export interface RevealEnvelope {
  kind: 'reveal'
  body: Uint8Array
  contentType: string
  prev?: string
  sha256?: string
  length?: number
  contentEncoding?: string
  metadata?: unknown
}

export interface ChunkEnvelope {
  kind: 'chunk'
  body: Uint8Array
  prev?: string
}

export type Envelope = RevealEnvelope | ChunkEnvelope

export class EnvelopeError extends Error {}

/**
 * Read the protocol memos of a transaction. Returns null when the transaction
 * carries none, and throws EnvelopeError when it carries a malformed set.
 */
export function parseEnvelope(tx: { Memos?: unknown }): Envelope | null {
  const memos = fromXrplMemos(tx.Memos).filter((m) => m.type === MEMO_TYPES.body || m.type.startsWith('ord:'))
  if (memos.length === 0) return null

  const byType = new Map<string, Memo>()
  for (const memo of memos) {
    if (byType.has(memo.type)) throw new EnvelopeError(`duplicate ${memo.type} memo`)
    byType.set(memo.type, memo)
  }
  const data = (type: string) => byType.get(type)?.data ?? new Uint8Array()
  const hash = (type: string) => {
    if (!byType.has(type)) return undefined
    const bytes = data(type)
    if (bytes.length !== HASH_BYTES) throw new EnvelopeError(`${type} must be ${HASH_BYTES} bytes`)
    return toHex(bytes)
  }
  const prev = hash(MEMO_TYPES.prev)

  const body = byType.get(MEMO_TYPES.body)
  if (!body) {
    if (!byType.has(MEMO_TYPES.chunk)) return null
    return { kind: 'chunk', body: data(MEMO_TYPES.chunk), prev }
  }

  const envelope: RevealEnvelope = {
    kind: 'reveal',
    body: body.data ?? new Uint8Array(),
    contentType: body.format ?? 'application/octet-stream',
    prev,
    sha256: hash(MEMO_TYPES.sha256),
  }
  if (byType.has(MEMO_TYPES.len)) {
    const text = fromUtf8(data(MEMO_TYPES.len))
    if (!/^(0|[1-9][0-9]{0,14})$/.test(text)) throw new EnvelopeError(`invalid ${MEMO_TYPES.len}: ${text}`)
    envelope.length = Number(text)
  }
  if (byType.has(MEMO_TYPES.enc)) envelope.contentEncoding = fromUtf8(data(MEMO_TYPES.enc))
  if (byType.has(MEMO_TYPES.meta)) {
    try {
      envelope.metadata = JSON.parse(fromUtf8(data(MEMO_TYPES.meta)))
    } catch {
      throw new EnvelopeError(`${MEMO_TYPES.meta} is not valid JSON`)
    }
  }
  if (prev !== undefined && (envelope.sha256 === undefined || envelope.length === undefined)) {
    throw new EnvelopeError(`a chunked reveal must carry ${MEMO_TYPES.sha256} and ${MEMO_TYPES.len}`)
  }
  return envelope
}

/** Accepts "<hash>i0", "<hash>" (either case) and returns the uppercase reveal hash. */
export function parseInscriptionId(id: string): string {
  const match = /^([0-9A-Fa-f]{64})(?:i0)?$/.exec(id.trim())
  if (!match) throw new Error(`invalid inscription id: ${id}`)
  return match[1].toUpperCase()
}

export function formatInscriptionId(revealHash: string): string {
  return `${revealHash.toUpperCase()}i0`
}

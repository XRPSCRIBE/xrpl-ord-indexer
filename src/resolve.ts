import { getNFTokenID } from 'xrpl'
import { LedgerReader, LedgerTx } from './client.js'
import { EnvelopeError, formatInscriptionId, parseEnvelope, parseInscriptionId, sha256 } from './protocol.js'

export interface Inscription {
  id: string
  revealHash: string
  /** The account that signed the reveal. */
  inscriber: string
  /** "nft" when the reveal minted an NFToken (ownership follows the token), else "account". */
  binding: 'nft' | 'account'
  nftokenId?: string
  contentType: string
  contentEncoding?: string
  metadata?: unknown
  body: Uint8Array
  length: number
  sha256: string
  /** Chunk transaction hashes in chain order (first chunk first). */
  chunkHashes: string[]
  /** What putting it on chain cost: the network fees of the reveal and every chunk, in drops. */
  feeDrops?: string
  ledgerIndex?: number
  closeTime?: string
}

export class InscriptionError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_validated' | 'not_inscription' | 'invalid',
    message: string,
  ) {
    super(message)
  }
}

export interface ResolveOptions {
  /** Refuse to walk more chunk transactions than this. */
  maxChunks?: number
}

export async function resolveInscription(
  reader: LedgerReader,
  id: string,
  options: ResolveOptions = {},
): Promise<Inscription> {
  const hash = parseInscriptionId(id)
  const reveal = await reader.getTx(hash)
  if (!reveal) throw new InscriptionError('not_found', `transaction ${hash} not found (the server may lack full history)`)
  return inscriptionFromTx(reader, reveal, options)
}

/** Validate a reveal transaction and reassemble its body. Throws InscriptionError if it is not a valid inscription. */
export async function inscriptionFromTx(
  reader: LedgerReader,
  reveal: LedgerTx,
  options: ResolveOptions = {},
): Promise<Inscription> {
  const maxChunks = options.maxChunks ?? 100_000
  if (!reveal.validated) throw new InscriptionError('not_validated', `transaction ${reveal.hash} is not validated yet`)
  requireSuccess(reveal)

  const envelope = envelopeOf(reveal)
  if (envelope?.kind !== 'reveal') {
    throw new InscriptionError('not_inscription', `transaction ${reveal.hash} is not an inscription reveal`)
  }

  const account = reveal.tx.Account
  const pieces: Uint8Array[] = [envelope.body]
  const chunkHashes: string[] = []
  let total = envelope.body.length
  let fees = BigInt(reveal.tx.Fee ?? 0)
  let prev = envelope.prev
  while (prev !== undefined) {
    if (chunkHashes.length >= maxChunks) throw new InscriptionError('invalid', `more than ${maxChunks} chunks`)
    const chunk = await reader.getTx(prev)
    if (!chunk) throw new InscriptionError('not_found', `chunk ${prev} not found (the server may lack full history)`)
    if (!chunk.validated) throw new InscriptionError('invalid', `chunk ${prev} is not validated`)
    requireSuccess(chunk)
    if (chunk.tx.Account !== account) throw new InscriptionError('invalid', `chunk ${prev} was sent by a different account`)
    const chunkEnvelope = envelopeOf(chunk)
    if (chunkEnvelope?.kind !== 'chunk') throw new InscriptionError('invalid', `transaction ${prev} is not an inscription chunk`)
    total += chunkEnvelope.body.length
    if (envelope.length !== undefined && total > envelope.length) {
      throw new InscriptionError('invalid', 'chunks exceed the declared length')
    }
    pieces.push(chunkEnvelope.body)
    chunkHashes.push(chunk.hash)
    fees += BigInt(chunk.tx.Fee ?? 0)
    prev = chunkEnvelope.prev
  }
  pieces.reverse()
  chunkHashes.reverse()

  const body = new Uint8Array(Buffer.concat(pieces))
  const digest = sha256(body)
  if (envelope.length !== undefined && body.length !== envelope.length) {
    throw new InscriptionError('invalid', `body is ${body.length} bytes but ${envelope.length} were declared`)
  }
  if (envelope.sha256 !== undefined && digest !== envelope.sha256) {
    throw new InscriptionError('invalid', 'body does not match the declared sha256')
  }

  const nftokenId = reveal.tx.TransactionType === 'NFTokenMint' ? nftokenIdOf(reveal) : undefined
  return {
    id: formatInscriptionId(reveal.hash),
    revealHash: reveal.hash,
    inscriber: account,
    binding: nftokenId ? 'nft' : 'account',
    nftokenId,
    contentType: envelope.contentType,
    contentEncoding: envelope.contentEncoding,
    metadata: envelope.metadata,
    body,
    length: body.length,
    sha256: digest,
    chunkHashes,
    feeDrops: fees.toString(),
    ledgerIndex: reveal.ledgerIndex,
    closeTime: reveal.closeTime,
  }
}

function requireSuccess(t: LedgerTx): void {
  const result = t.meta?.TransactionResult
  if (result !== 'tesSUCCESS') throw new InscriptionError('invalid', `transaction ${t.hash} failed with ${result ?? 'no result'}`)
}

function envelopeOf(t: LedgerTx) {
  try {
    return parseEnvelope(t.tx)
  } catch (err) {
    if (err instanceof EnvelopeError) throw new InscriptionError('invalid', `transaction ${t.hash}: ${err.message}`)
    throw err
  }
}

function nftokenIdOf(t: LedgerTx): string | undefined {
  if (typeof t.meta?.nftoken_id === 'string') return t.meta.nftoken_id
  try {
    return getNFTokenID(t.meta as any)
  } catch {
    return undefined
  }
}

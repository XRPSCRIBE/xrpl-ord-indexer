import { encode } from 'xrpl'

/**
 * rippled rejects any transaction whose serialized Memos array exceeds this
 * many bytes (see `isMemoOkay` in rippled's STTx.cpp). The count covers every
 * Memo object, including field headers and length prefixes.
 */
export const MEMO_LIMIT = 1024

/** Characters rippled allows in MemoType / MemoFormat (RFC 3986 URL characters). */
const URL_SAFE = /^[0-9A-Za-z\-._~:/?#[\]@!$&'()*+,;=%]*$/

export interface Memo {
  type: string
  data?: Uint8Array
  format?: string
}

export interface XrplMemo {
  Memo: {
    MemoType?: string
    MemoData?: string
    MemoFormat?: string
  }
}

// Hex and UTF-8 helpers avoid Buffer so the protocol code also runs in browsers.
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase())

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += HEX[byte]
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(hex)) {
    throw new Error(`invalid hex string: ${hex.slice(0, 32)}`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  // ignoreBOM keeps a leading BOM, as Buffer#toString does.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
}

export function isUrlSafe(text: string): boolean {
  return URL_SAFE.test(text)
}

export function toXrplMemos(memos: Memo[]): XrplMemo[] {
  return memos.map((memo) => {
    if (!isUrlSafe(memo.type)) {
      throw new Error(`MemoType "${memo.type}" contains characters rippled rejects`)
    }
    if (memo.format !== undefined && !isUrlSafe(memo.format)) {
      throw new Error(`MemoFormat "${memo.format}" contains characters rippled rejects`)
    }
    const out: XrplMemo['Memo'] = { MemoType: toHex(utf8(memo.type)) }
    if (memo.data && memo.data.length > 0) out.MemoData = toHex(memo.data)
    if (memo.format) out.MemoFormat = toHex(utf8(memo.format))
    return { Memo: out }
  })
}

export function fromXrplMemos(memos: unknown): Memo[] {
  if (!Array.isArray(memos)) return []
  const out: Memo[] = []
  for (const wrapper of memos) {
    const memo = (wrapper as XrplMemo | undefined)?.Memo
    if (!memo || typeof memo !== 'object') continue
    try {
      out.push({
        type: memo.MemoType ? fromUtf8(fromHex(memo.MemoType)) : '',
        data: memo.MemoData ? fromHex(memo.MemoData) : new Uint8Array(),
        format: memo.MemoFormat ? fromUtf8(fromHex(memo.MemoFormat)) : undefined,
      })
    } catch {
      // Not hex: cannot be a memo written by this protocol.
    }
  }
  return out
}

/** Size of the Memos array exactly as rippled measures it against MEMO_LIMIT. */
export function memosSize(memos: Memo[]): number {
  const hex = encode({ Memos: toXrplMemos(memos) } as Parameters<typeof encode>[0])
  // Drop the STArray field header (0xF9) and end marker (0xF1), which rippled
  // does not count.
  return hex.length / 2 - 2
}

/**
 * Largest n such that `build(n)` (memos carrying n data bytes) fits in `limit`.
 * Returns -1 when even zero bytes do not fit.
 */
export function maxDataBytes(build: (n: number) => Memo[], limit: number): number {
  // Every data byte adds at least one serialized byte, so stepping down by the
  // overshoot always lands inside the limit; a shrinking length prefix can
  // leave a byte or two of slack, which the second loop reclaims.
  let n = limit
  let size = memosSize(build(n))
  while (size > limit) {
    n -= size - limit
    if (n < 0) return memosSize(build(0)) <= limit ? 0 : -1
    size = memosSize(build(n))
  }
  while (memosSize(build(n + 1)) <= limit) n++
  return n
}

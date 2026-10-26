// XRC-20: fungible tokens on XRPL inscriptions, after BRC-20 on Bitcoin.
//
// A token operation is a small JSON inscription (text/plain or application/json):
//   {"p":"xrc-20","op":"deploy","tick":"xogi","max":"100000000000","lim":"1000"}
//   {"p":"xrc-20","op":"mint","tick":"xogi","amt":"1000"}
//   {"p":"xrc-20","op":"transfer","tick":"xogi","amt":"250"}
// Balances are not on the ledger: they follow from reading every operation in
// inscription order (ledger, then transaction order), as BRC-20 indexers do.
//  - deploy: the first deploy of a ticker wins. max is the supply, lim the most
//    one mint may claim (default max), dec the decimals (0-18, default 18).
//  - mint: credits the inscriber up to lim, or whatever supply is left.
//  - transfer: if the inscriber has the amount available when it is inscribed,
//    it is set aside (transferable). It must be an NFT: when the NFT first moves
//    to another account, the amount moves to that account. Burning it, or the NFT
//    coming back to its inscriber, returns the amount. After that first move the
//    inscription is spent and further moves change nothing.
// Anything else is not a valid operation and changes nothing.

export const XRC20_PROTOCOL = 'xrc-20'
const TICK = /^[a-z0-9]{4}$/
const NUMBER = /^(0|[1-9]\d{0,38})(\.\d{1,18})?$/
const MAX_BODY_BYTES = 1024

export type Xrc20Op =
  | { op: 'deploy'; tick: string; max: string; lim?: string; dec?: number }
  | { op: 'mint'; tick: string; amt: string }
  | { op: 'transfer'; tick: string; amt: string }

/** The operation an inscription carries, or undefined when it is not a well-formed XRC-20 operation. */
export function parseXrc20(contentType: string, body: Uint8Array, contentEncoding?: string): Xrc20Op | undefined {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if ((type !== 'text/plain' && type !== 'application/json') || contentEncoding || body.length > MAX_BODY_BYTES) return undefined
  let value: any
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  if (String(value.p ?? '').toLowerCase() !== XRC20_PROTOCOL || typeof value.tick !== 'string') return undefined
  const tick = value.tick.toLowerCase()
  if (!TICK.test(tick)) return undefined
  const num = (v: unknown) => (typeof v === 'string' && NUMBER.test(v) ? v : undefined)
  switch (value.op) {
    case 'deploy': {
      const max = num(value.max)
      if (!max) return undefined
      const lim = value.lim === undefined ? undefined : num(value.lim)
      if (value.lim !== undefined && !lim) return undefined
      const dec = value.dec === undefined ? undefined : Number(value.dec)
      if (dec !== undefined && !(Number.isInteger(dec) && dec >= 0 && dec <= 18)) return undefined
      return { op: 'deploy', tick, max, ...(lim ? { lim } : {}), ...(dec !== undefined ? { dec } : {}) }
    }
    case 'mint':
    case 'transfer': {
      const amt = num(value.amt)
      return amt ? { op: value.op, tick, amt } : undefined
    }
    default:
      return undefined
  }
}

/** A decimal string as whole units at `dec` decimals; undefined if it has more decimals than that. */
export function toUnits(amount: string, dec: number): bigint | undefined {
  const [whole, fraction = ''] = amount.split('.')
  if (fraction.length > dec) return undefined
  return BigInt(whole) * 10n ** BigInt(dec) + BigInt(fraction.padEnd(dec, '0') || '0')
}

export function fromUnits(units: bigint, dec: number): string {
  if (dec === 0) return units.toString()
  const scale = 10n ** BigInt(dec)
  const fraction = (units % scale).toString().padStart(dec, '0').replace(/0+$/, '')
  return `${units / scale}${fraction ? `.${fraction}` : ''}`
}

/** What the log records, in ledger order. State is a replay of these. */
export type Xrc20Event =
  | { kind: 'inscription'; hash: string; ledger: number; txIndex: number; time?: string; id: string; number: number; inscriber: string; nftokenId?: string; op: Xrc20Op }
  | { kind: 'move'; hash: string; ledger: number; txIndex: number; time?: string; nftokenId: string; from: string; to: string }
  | { kind: 'burn'; hash: string; ledger: number; txIndex: number; time?: string; nftokenId: string }

export interface Xrc20Token {
  tick: string
  max: string
  lim: string
  dec: number
  minted: string
  mints: number
  holders: number
  deployer: string
  deployId: string
  deployNumber: number
  deployedAt?: string
}

export interface Xrc20Balance {
  tick: string
  available: string
  transferable: string
  total: string
}

/** One line of a token's history. */
export interface Xrc20Activity {
  type: 'deploy' | 'mint' | 'transfer-inscribed' | 'transfer' | 'returned'
  hash: string
  time?: string
  amount: string
  from?: string
  to?: string
  inscriptionId?: string
  number?: number
}

/** How the index judged one inscription. */
export interface Xrc20Verdict {
  op: Xrc20Op
  valid: boolean
  reason?: string
  /** For a valid mint, what was credited (less than asked at the end of the supply). */
  credited?: string
  /** For a valid transfer inscription: still to be sent, or sent to whom. */
  state?: 'unspent' | 'spent' | 'returned'
  to?: string
}

interface TokenState {
  tick: string
  max: bigint
  lim: bigint
  dec: number
  minted: bigint
  mints: number
  deployer: string
  deployId: string
  deployNumber: number
  deployedAt?: string
  balances: Map<string, { available: bigint; transferable: bigint }>
  activity: Xrc20Activity[]
}

const ACTIVITY_KEPT = 500

export class Xrc20Ledger {
  private readonly tokens = new Map<string, TokenState>()
  /** Valid, unspent transfer inscriptions by NFToken ID. */
  private readonly pending = new Map<string, { tick: string; amount: bigint; owner: string; id: string }>()
  private readonly verdicts = new Map<string, Xrc20Verdict>()
  private readonly seen = new Set<string>()

  /** Apply one event; repeats (same kind, transaction and NFT) are ignored. Returns whether it was new. */
  apply(event: Xrc20Event): boolean {
    const key = `${event.kind}:${event.hash}:${'nftokenId' in event ? (event.nftokenId ?? '') : ''}`
    if (this.seen.has(key)) return false
    this.seen.add(key)
    if (event.kind === 'inscription') this.inscription(event)
    else if (event.kind === 'move') this.move(event.nftokenId, event.from, event.to, event)
    else this.returnPending(event.nftokenId, event)
    return true
  }

  /** Whether moves of this NFT matter (it is an unspent transfer inscription). */
  isPending(nftokenId: string): boolean {
    return this.pending.has(nftokenId.toUpperCase())
  }

  verdict(inscriptionId: string): Xrc20Verdict | undefined {
    return this.verdicts.get(inscriptionId.toUpperCase())
  }

  list(): Xrc20Token[] {
    return [...this.tokens.values()].sort((a, b) => a.deployNumber - b.deployNumber).map(summary)
  }

  token(tick: string): Xrc20Token | undefined {
    const t = this.tokens.get(tick.toLowerCase())
    return t ? summary(t) : undefined
  }

  holders(tick: string, page = 1, size = 100): { items: Array<{ address: string } & Omit<Xrc20Balance, 'tick'>>; total: number } {
    const t = this.tokens.get(tick.toLowerCase())
    if (!t) return { items: [], total: 0 }
    const all = [...t.balances.entries()]
      .map(([address, b]) => ({ address, units: b.available + b.transferable, b }))
      .filter((x) => x.units > 0n)
      .sort((a, b) => (a.units > b.units ? -1 : a.units < b.units ? 1 : a.address.localeCompare(b.address)))
    return {
      total: all.length,
      items: all.slice((page - 1) * size, page * size).map((x) => ({ address: x.address, available: fromUnits(x.b.available, t.dec), transferable: fromUnits(x.b.transferable, t.dec), total: fromUnits(x.units, t.dec) })),
    }
  }

  /** Newest first. */
  activity(tick: string, limit = 50): Xrc20Activity[] {
    return [...(this.tokens.get(tick.toLowerCase())?.activity ?? [])].reverse().slice(0, limit)
  }

  balances(address: string): Xrc20Balance[] {
    const out: Xrc20Balance[] = []
    for (const t of this.tokens.values()) {
      const b = t.balances.get(address)
      if (!b || b.available + b.transferable === 0n) continue
      out.push({ tick: t.tick, available: fromUnits(b.available, t.dec), transferable: fromUnits(b.transferable, t.dec), total: fromUnits(b.available + b.transferable, t.dec) })
    }
    return out
  }

  /** Every unspent transfer inscription of a token: the ones that can be sold. */
  pendingOf(tick: string): Array<{ amount: string; units: bigint; inscriptionId: string; nftokenId: string; owner: string }> {
    const token = this.tokens.get(tick.toLowerCase())
    if (!token) return []
    const out = []
    for (const [nftokenId, p] of this.pending) {
      if (p.tick === token.tick) out.push({ amount: fromUnits(p.amount, token.dec), units: p.amount, inscriptionId: p.id, nftokenId, owner: p.owner })
    }
    return out
  }

  /** Unspent transfer inscriptions held for this account (to send or sell). */
  transferables(address: string): Array<{ tick: string; amount: string; inscriptionId: string; nftokenId: string }> {
    const out = []
    for (const [nftokenId, p] of this.pending) {
      if (p.owner !== address) continue
      out.push({ tick: p.tick, amount: fromUnits(p.amount, this.tokens.get(p.tick)!.dec), inscriptionId: p.id, nftokenId })
    }
    return out
  }

  private inscription(e: Extract<Xrc20Event, { kind: 'inscription' }>): void {
    const { op } = e
    const judge = (valid: boolean, reason?: string, extra: Partial<Xrc20Verdict> = {}): void => void this.verdicts.set(e.id.toUpperCase(), { op, valid, ...(reason ? { reason } : {}), ...extra })
    const token = this.tokens.get(op.tick)
    if (op.op === 'deploy') {
      if (token) return judge(false, `${op.tick} was already deployed by inscription #${token.deployNumber}`)
      const dec = op.dec ?? 18
      const max = toUnits(op.max, dec)
      const lim = op.lim === undefined ? max : toUnits(op.lim, dec)
      if (max === undefined || lim === undefined) return judge(false, `more decimals than the token's ${dec}`)
      if (max <= 0n) return judge(false, 'max must be above 0')
      if (lim <= 0n || lim > max) return judge(false, 'lim must be above 0 and at most max')
      this.tokens.set(op.tick, { tick: op.tick, max, lim, dec, minted: 0n, mints: 0, deployer: e.inscriber, deployId: e.id, deployNumber: e.number, deployedAt: e.time, balances: new Map(), activity: [] })
      this.log(op.tick, { type: 'deploy', hash: e.hash, time: e.time, amount: fromUnits(max, dec), from: e.inscriber, inscriptionId: e.id, number: e.number })
      return judge(true)
    }
    if (!token) return judge(false, `${op.tick} has not been deployed`)
    const amount = toUnits(op.amt, token.dec)
    if (amount === undefined) return judge(false, `more decimals than ${op.tick}'s ${token.dec}`)
    if (amount <= 0n) return judge(false, 'the amount must be above 0')
    if (op.op === 'mint') {
      if (amount > token.lim) return judge(false, `above the mint limit of ${fromUnits(token.lim, token.dec)}`)
      const left = token.max - token.minted
      if (left <= 0n) return judge(false, `${op.tick} is fully minted`)
      const credited = amount < left ? amount : left
      this.balance(token, e.inscriber).available += credited
      token.minted += credited
      token.mints++
      this.log(op.tick, { type: 'mint', hash: e.hash, time: e.time, amount: fromUnits(credited, token.dec), to: e.inscriber, inscriptionId: e.id, number: e.number })
      return judge(true, undefined, { credited: fromUnits(credited, token.dec) })
    }
    // transfer
    if (!e.nftokenId) return judge(false, 'a transfer must be inscribed as an NFT, so it can be sent')
    const b = this.balance(token, e.inscriber)
    if (b.available < amount) return judge(false, `the inscriber had only ${fromUnits(b.available, token.dec)} ${op.tick} available`)
    b.available -= amount
    b.transferable += amount
    this.pending.set(e.nftokenId.toUpperCase(), { tick: op.tick, amount, owner: e.inscriber, id: e.id })
    this.log(op.tick, { type: 'transfer-inscribed', hash: e.hash, time: e.time, amount: fromUnits(amount, token.dec), from: e.inscriber, inscriptionId: e.id, number: e.number })
    judge(true, undefined, { state: 'unspent' })
  }

  private move(nftokenId: string, from: string, to: string, e: { hash: string; time?: string }): void {
    const p = this.pending.get(nftokenId.toUpperCase())
    if (!p) return
    if (to === p.owner || from !== p.owner) return this.returnPending(nftokenId, e)
    const token = this.tokens.get(p.tick)!
    this.balance(token, p.owner).transferable -= p.amount
    this.balance(token, to).available += p.amount
    this.pending.delete(nftokenId.toUpperCase())
    const v = this.verdicts.get(p.id.toUpperCase())
    if (v) Object.assign(v, { state: 'spent', to })
    this.log(p.tick, { type: 'transfer', hash: e.hash, time: e.time, amount: fromUnits(p.amount, token.dec), from: p.owner, to, inscriptionId: p.id })
  }

  /** The amount goes back to the inscriber's available balance; the inscription is spent. */
  private returnPending(nftokenId: string, e: { hash: string; time?: string }): void {
    const p = this.pending.get(nftokenId.toUpperCase())
    if (!p) return
    const token = this.tokens.get(p.tick)!
    const b = this.balance(token, p.owner)
    b.transferable -= p.amount
    b.available += p.amount
    this.pending.delete(nftokenId.toUpperCase())
    const v = this.verdicts.get(p.id.toUpperCase())
    if (v) v.state = 'returned'
    this.log(p.tick, { type: 'returned', hash: e.hash, time: e.time, amount: fromUnits(p.amount, token.dec), to: p.owner, inscriptionId: p.id })
  }

  private balance(token: TokenState, address: string): { available: bigint; transferable: bigint } {
    let b = token.balances.get(address)
    if (!b) token.balances.set(address, (b = { available: 0n, transferable: 0n }))
    return b
  }

  private log(tick: string, entry: Xrc20Activity): void {
    const activity = this.tokens.get(tick)!.activity
    activity.push(entry)
    if (activity.length > ACTIVITY_KEPT) activity.splice(0, activity.length - ACTIVITY_KEPT)
  }
}

function summary(t: TokenState): Xrc20Token {
  let holders = 0
  for (const b of t.balances.values()) if (b.available + b.transferable > 0n) holders++
  return {
    tick: t.tick,
    max: fromUnits(t.max, t.dec),
    lim: fromUnits(t.lim, t.dec),
    dec: t.dec,
    minted: fromUnits(t.minted, t.dec),
    mints: t.mints,
    holders,
    deployer: t.deployer,
    deployId: t.deployId,
    deployNumber: t.deployNumber,
    ...(t.deployedAt ? { deployedAt: t.deployedAt } : {}),
  }
}

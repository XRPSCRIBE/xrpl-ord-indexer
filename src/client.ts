import { HttpsProxyAgent } from 'https-proxy-agent'
import { Client, ConnectionError } from 'xrpl'

/** A transaction as returned by the `tx` or `ledger` methods, normalized across API versions. */
export interface LedgerTx {
  hash: string
  tx: Record<string, any>
  meta?: Record<string, any>
  validated: boolean
  ledgerIndex?: number
  closeTime?: string
}

/** Read access needed to resolve inscriptions. */
export interface LedgerReader {
  /** Look up a transaction by hash; null when the server does not know it. */
  getTx(hash: string): Promise<LedgerTx | null>
}

/** Everything the inscriber needs from a rippled connection. */
export interface LedgerClient extends LedgerReader {
  /** Next Sequence the account may use, counting transactions in the open ledger. */
  nextSequence(account: string): Promise<number>
  validatedLedgerIndex(): Promise<number>
  /** Base and current open-ledger transaction cost, in drops. */
  fee(): Promise<{ base: number; open: number }>
  /** Submit a signed blob; returns rippled's preliminary engine result. */
  submit(txBlob: string): Promise<string>
}

/**
 * Public servers per network, tried in order. No node of your own is needed:
 * transactions are signed locally and only signed blobs are sent. Reads of old
 * chunks need full history, so full-history servers come first; a server that
 * answers txnNotFound is never trusted alone.
 */
export const NETWORKS: Record<string, string[]> = {
  mainnet: ['wss://xrplcluster.com', 'wss://s2.ripple.com', 'wss://s1.ripple.com'],
  testnet: ['wss://s.altnet.rippletest.net:51233', 'wss://testnet.xrpl-labs.com', 'wss://clio.altnet.rippletest.net:51233'],
  devnet: ['wss://s.devnet.rippletest.net:51233', 'wss://clio.devnet.rippletest.net:51233'],
}

/** A network name, a single wss:// URL, or a comma-separated list of URLs. */
export function resolveNetwork(network: string): string[] {
  return NETWORKS[network] ?? network.split(',').map((url) => url.trim()).filter(Boolean)
}

/** No server we use has this ledger: public servers keep limited history. */
export class LedgerNotFoundError extends Error {
  constructor(readonly ledgerIndex: number) {
    super(`no server has ledger ${ledgerIndex}: public servers keep limited history. Use a full-history server, e.g. --network wss://xrplcluster.com (mainnet) or wss://s.altnet.rippletest.net:51233 (testnet)`)
  }
}

/** rippled errors that mean "try again later or elsewhere", which public servers return under load. */
const RETRYABLE = new Set(['slowDown', 'tooBusy', 'noCurrent', 'noClosed', 'noNetwork', 'amendmentBlocked', 'failedToForward'])

/** The longest a rate-limited server is left alone, whatever it asks for. */
const MAX_REST_MS = 60 * 60 * 1000
/** The longest one request waits when every server is resting. */
const MAX_WAIT_MS = 60 * 1000

/** How long a rate-limited server asked to be left alone ("… retry in ~1939604ms"), if it said. */
export function restFor(err: unknown): number | undefined {
  const match = /retry in ~?(\d+)\s*ms/.exec(String((err as any)?.data?.error_message ?? ''))
  return match ? Math.min(Number(match[1]), MAX_REST_MS) : undefined
}

export interface ClientOptions {
  /** Attempts per request across all endpoints (default 6). */
  retries?: number
  /** First backoff delay; doubles per attempt (default 500 ms). */
  backoffMs?: number
}

/** Honor HTTPS_PROXY / NO_PROXY, which xrpl.js's websocket does not read on its own. */
export function proxyAgentFor(url: string, env: NodeJS.ProcessEnv = process.env): HttpsProxyAgent<string> | undefined {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy
  if (!proxy) return undefined
  const host = new URL(url).hostname
  const bypass = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^\*?\./, ''))
    .some((entry) => entry && (host === entry || host.endsWith(`.${entry}`)))
  return bypass ? undefined : new HttpsProxyAgent(proxy)
}

/** Normalize a transaction from `tx` (API v1 or v2) or from an expanded `ledger` response. */
export function normalizeTx(raw: Record<string, any>, ledgerIndex?: number): LedgerTx {
  const tx = raw.tx_json ?? raw.tx ?? raw
  const meta = raw.meta ?? raw.metaData
  const closeTime = raw.close_time_iso ?? (typeof raw.date === 'number' ? rippleTimeToIso(raw.date) : undefined)
  return {
    hash: String(raw.hash ?? tx.hash).toUpperCase(),
    tx,
    meta: typeof meta === 'object' ? meta : undefined,
    validated: raw.validated ?? true,
    ledgerIndex: raw.ledger_index ?? tx.ledger_index ?? ledgerIndex,
    closeTime,
  }
}

const RIPPLE_EPOCH = 946684800

function rippleTimeToIso(seconds: number): string {
  return new Date((seconds + RIPPLE_EPOCH) * 1000).toISOString()
}

/**
 * LedgerClient over public XRPL servers. Requests that hit rate limits or
 * dropped connections are retried with backoff, rotating to the next endpoint.
 */
export class XrplLedgerClient implements LedgerClient {
  readonly endpoints: string[]
  private readonly clients: Client[]
  private current = 0
  private readonly retries: number
  private readonly backoffMs: number
  /** Per endpoint: until when it asked not to be sent requests (ms since epoch). */
  private readonly restingUntil: number[]

  constructor(network: string | string[] | Client, options: ClientOptions = {}) {
    if (network instanceof Client) {
      this.clients = [network]
      this.endpoints = [network.url]
    } else {
      this.endpoints = Array.isArray(network) ? network : resolveNetwork(network)
      if (this.endpoints.length === 0) throw new Error('no endpoints given')
      this.clients = this.endpoints.map((url) => new Client(url, { agent: proxyAgentFor(url) }))
    }
    this.retries = options.retries ?? 6
    this.backoffMs = options.backoffMs ?? 500
    this.restingUntil = this.endpoints.map(() => 0)
  }

  /** The endpoint requests currently go to. */
  get url(): string {
    return this.endpoints[this.current]
  }

  /** Connect to the first endpoint that answers, starting with the current one. */
  async connect(): Promise<void> {
    let lastError: unknown
    for (let tried = 0; tried < this.clients.length; tried++) {
      try {
        await this.ensureConnected(this.current)
        return
      } catch (err) {
        lastError = err
        this.rotate()
      }
    }
    throw lastError
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.clients.map((c) => (c.isConnected() ? c.disconnect() : undefined)))
  }

  private async ensureConnected(index: number): Promise<Client> {
    const client = this.clients[index]
    if (!client.isConnected()) await client.connect()
    return client
  }

  private rotate(): void {
    this.current = (this.current + 1) % this.clients.length
  }

  /**
   * Move off an endpoint that is resting, to the next one that is not. When all
   * are resting, wait (up to a minute) for the first to be ready instead.
   */
  private async avoidResting(): Promise<void> {
    const now = Date.now()
    if (this.restingUntil[this.current] <= now) return
    for (let step = 1; step < this.clients.length; step++) {
      const index = (this.current + step) % this.clients.length
      if (this.restingUntil[index] <= now) {
        this.current = index
        return
      }
    }
    const soonest = this.restingUntil.indexOf(Math.min(...this.restingUntil))
    this.current = soonest
    await new Promise((resolve) => setTimeout(resolve, Math.min(this.restingUntil[soonest] - now, MAX_WAIT_MS)))
  }

  async request(request: Record<string, unknown>): Promise<any> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.avoidResting()
      try {
        const client = await this.ensureConnected(this.current)
        const response = await client.request(request as any)
        return (response as any).result
      } catch (err) {
        lastError = err
        const code = (err as any)?.data?.error
        const connectionProblem = err instanceof ConnectionError || (err as any)?.code === 'ECONNREFUSED'
        if (!connectionProblem && !RETRYABLE.has(code)) throw err
        // A server that says how long its rate limit lasts is skipped until then.
        const rest = restFor(err)
        if (rest !== undefined) this.restingUntil[this.current] = Date.now() + rest
        this.rotate()
        // Back off once every endpoint has been tried in this cycle (resting ones wait in avoidResting).
        if ((attempt + 1) % this.clients.length === 0 || (code === 'slowDown' && rest === undefined)) {
          await new Promise((resolve) => setTimeout(resolve, this.backoffMs * 2 ** Math.floor(attempt / this.clients.length)))
        }
      }
    }
    throw lastError
  }

  async getTx(hash: string): Promise<LedgerTx | null> {
    // Public servers keep different amounts of history: before reporting a
    // transaction missing, ask every endpoint once.
    for (let tried = 0; tried < this.clients.length; tried++) {
      try {
        return normalizeTx(await this.request({ command: 'tx', transaction: hash, binary: false }))
      } catch (err) {
        if ((err as any)?.data?.error !== 'txnNotFound') throw err
        if (tried + 1 < this.clients.length) this.rotate()
      }
    }
    return null
  }

  async nextSequence(account: string): Promise<number> {
    const result = await this.request({ command: 'account_info', account, ledger_index: 'current' })
    return result.account_data.Sequence
  }

  async validatedLedgerIndex(): Promise<number> {
    const result = await this.request({ command: 'ledger', ledger_index: 'validated' })
    return Number(result.ledger_index)
  }

  async fee(): Promise<{ base: number; open: number }> {
    const result = await this.request({ command: 'fee' })
    return { base: Number(result.drops.base_fee), open: Number(result.drops.open_ledger_fee) }
  }

  async submit(txBlob: string): Promise<string> {
    const result = await this.request({ command: 'submit', tx_blob: txBlob })
    return result.engine_result
  }

  /** Validated transactions of one ledger, in execution order. */
  async ledgerTransactions(ledgerIndex: number): Promise<LedgerTx[]> {
    // Like transactions, old ledgers are only on some servers: ask each before giving up.
    let result: any
    for (let tried = 0; ; tried++) {
      try {
        result = await this.request({ command: 'ledger', ledger_index: ledgerIndex, transactions: true, expand: true })
        break
      } catch (err) {
        if ((err as any)?.data?.error !== 'lgrNotFound') throw err
        if (tried + 1 >= this.clients.length) throw new LedgerNotFoundError(ledgerIndex)
        this.rotate()
      }
    }
    const ledger = result.ledger
    const txs: LedgerTx[] = (ledger.transactions ?? []).map((raw: any) => normalizeTx(raw, Number(ledger.ledger_index)))
    for (const t of txs) {
      t.validated = true
      t.closeTime ??= ledger.close_time_iso ?? (typeof ledger.close_time === 'number' ? rippleTimeToIso(ledger.close_time) : undefined)
    }
    return txs.sort((a, b) => (a.meta?.TransactionIndex ?? 0) - (b.meta?.TransactionIndex ?? 0))
  }

  /** Index of the endpoint that last answered nft_info (a Clio server). */
  private nftInfoEndpoint = 0

  /**
   * Current holder of an NFToken, via Clio's `nft_info`. Plain rippled servers
   * do not know the method, so each endpoint is asked directly, starting with
   * the one that answered last time. This never moves the shared endpoint
   * used by other requests, so concurrent lookups cannot disturb each other.
   * Undefined when no endpoint can answer.
   */
  async nftOwner(nftokenId: string): Promise<string | undefined> {
    for (let tried = 0; tried < this.clients.length; tried++) {
      const index = (this.nftInfoEndpoint + tried) % this.clients.length
      try {
        const client = await this.ensureConnected(index)
        const result = (await client.request({ command: 'nft_info', nft_id: nftokenId } as any)).result as any
        this.nftInfoEndpoint = index
        return result.is_burned ? undefined : result.owner
      } catch (err) {
        if ((err as any)?.data?.error === 'objectNotFound') {
          this.nftInfoEndpoint = index
          return undefined
        }
        // unknownCmd (not Clio), rate limits and connection errors: try the next endpoint.
      }
    }
    return undefined
  }
}

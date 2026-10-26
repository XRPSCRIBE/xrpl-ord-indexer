// The XRC-20 event log: every token operation and every move of an unspent
// transfer inscription, appended in ledger order. Balances are a replay of it,
// so they survive restarts and the rules can be re-run over the same events.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { Xrc20Event, Xrc20Ledger } from './xrc20.js'

export class Xrc20Log {
  readonly ledger = new Xrc20Ledger()

  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        this.ledger.apply(JSON.parse(line) as Xrc20Event)
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
  }

  get exists(): boolean {
    return existsSync(this.path)
  }

  /** Create the file if it is not there yet. */
  touch(): void {
    if (!existsSync(this.path)) appendFileSync(this.path, '')
  }

  /** Apply an event and keep it (repeats, e.g. a ledger re-read after a restart, are ignored). */
  record(event: Xrc20Event): void {
    if (this.ledger.apply(event)) appendFileSync(this.path, JSON.stringify(event) + '\n')
  }
}

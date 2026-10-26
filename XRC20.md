# XRC-20 — fungible tokens on XRPL inscriptions

XRC-20 follows BRC-20 on Bitcoin. A token operation is a small JSON inscription (see [SPEC.md](SPEC.md) for inscriptions themselves). The ledger stores any JSON you inscribe. These rules decide which operations count, and balances follow from reading every operation in inscription order.

## Operations

```json
{"p":"xrc-20","op":"deploy","tick":"xogi","max":"100000000000","lim":"1000"}
{"p":"xrc-20","op":"mint","tick":"xogi","amt":"1000"}
{"p":"xrc-20","op":"transfer","tick":"xogi","amt":"250"}
```

An operation is read only when all of these hold:

- The inscription's content type is `text/plain` or `application/json` (a `charset` parameter is fine), it has no content encoding, and its body is at most 1024 bytes of valid UTF-8 JSON.
- `p` is `xrc-20` (any case), and `op` is `deploy`, `mint` or `transfer`.
- `tick` is 4 letters or digits. Tickers are case-insensitive: `XOGI` and `xogi` are the same token.
- Amounts (`max`, `lim`, `amt`) are strings of digits, with an optional fraction: `"1000"`, `"0.5"`. Leading zeros are not allowed. JSON numbers are not accepted.

## Rules

Operations are applied in inscription order: validated ledger order, then transaction order within a ledger.

**deploy**
- The first deploy of a ticker wins. Later deploys of it are invalid.
- `max` is the total supply. It must be above 0.
- `lim` is the most one mint may claim. It is optional and defaults to `max`, and it must be above 0 and at most `max`.
- `dec` is the number of decimals, 0 to 18. It is optional and defaults to 18. Amounts with more decimals than this are invalid.

**mint**
- The token must already be deployed, and `amt` must be above 0 and at most `lim`.
- The mint credits the account that signed the inscription.
- If less than `amt` is left, the mint credits what is left. Once the supply is used up, further mints are invalid.

**transfer**
- The inscription must be bound to an NFToken (its reveal is an `NFTokenMint`) so that it can be sent.
- It is valid only if the inscriber has `amt` *available* when it is inscribed. The amount then moves from available to *transferable*.
- When the NFToken **first** moves to another account (any accepted NFT offer: a sale or a free transfer), the amount goes to that account's available balance.
- If the NFToken comes back to the inscriber or is burned before moving, the amount returns to the inscriber's available balance.
- After its first move, the inscription is spent. Further moves change nothing.

Anything else is not a valid operation and changes no balance.

## What the indexer records

`xrpl-ord-index` writes the token log (`<out>.xrc20.jsonl`) next to the inscription index. It contains one line per event, in ledger order:

- `inscription`: a token operation inscribed. The rules decide whether it is valid when the log is replayed.
- `move`: an unspent transfer inscription's NFToken moved between accounts.
- `burn`: an unspent transfer inscription's NFToken was burned.

Balances are a replay of this log (`Xrc20Ledger`), so the rules can be re-run over the same events. Index tokens together with inscriptions, from the start. A log started later is built from the inscriptions already indexed, but it cannot see transfers that moved before it existed.

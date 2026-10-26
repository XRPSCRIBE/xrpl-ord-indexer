// NFT moves read from ledger transactions: an XRC-20 transfer inscription is an
// NFT, and its tokens move with the NFT's first move to another account.
import type { LedgerTx } from './client.js'

function deletedOffers(meta: Record<string, any> | undefined): Map<string, Record<string, any>> {
  const offers = new Map<string, Record<string, any>>()
  for (const node of meta?.AffectedNodes ?? []) {
    const deleted = node.DeletedNode
    if (deleted?.LedgerEntryType === 'NFTokenOffer') offers.set(String(deleted.LedgerIndex).toUpperCase(), deleted.FinalFields ?? {})
  }
  return offers
}

/** Every NFT a transaction moved between accounts (sales and free transfers alike). */
export function transfersFromTx(t: LedgerTx): Array<{ nftokenId: string; from: string; to: string }> {
  if (t.tx.TransactionType !== 'NFTokenAcceptOffer' || t.meta?.TransactionResult !== 'tesSUCCESS') return []
  const deleted = deletedOffers(t.meta)
  const sell = t.tx.NFTokenSellOffer ? deleted.get(String(t.tx.NFTokenSellOffer).toUpperCase()) : undefined
  const buy = t.tx.NFTokenBuyOffer ? deleted.get(String(t.tx.NFTokenBuyOffer).toUpperCase()) : undefined
  const nftokenId = (sell ?? buy)?.NFTokenID
  if (typeof nftokenId !== 'string') return []
  // A sell offer moves the NFT from its owner to the buyer (or whoever accepted it);
  // a buy offer taken directly moves it from the accepting holder to the bidder.
  const from = sell ? sell.Owner : t.tx.Account
  const to = buy ? buy.Owner : t.tx.Account
  return from && to && from !== to ? [{ nftokenId: nftokenId.toUpperCase(), from, to }] : []
}

import { verifyMessage } from "ethers";

/**
 * Canonical message the buyer must sign (EIP-191). Server rebuilds this on verify.
 * @param {{ _id: unknown; priceWei?: string | null; contractAddress?: string | null; chainId?: number | null }} doc
 */
export function buildBuyAuthorizationMessage(doc) {
  const id = String(doc._id);
  const priceWei = String(doc.priceWei ?? "0").trim() || "0";
  const contract = String(doc.contractAddress ?? "")
    .trim()
    .toLowerCase();
  const chainId = Number(doc.chainId);
  return `NFT Marketplace Buy\nListing: ${id}\nPrice (wei): ${priceWei}\nContract: ${contract}\nChainId: ${chainId}`;
}

/**
 * @param {{ doc: Record<string, unknown>; signature: string }} args
 * @returns {{ message: string; buyerAddress: string }}
 */
export function recoverBuyerFromBuySignature(args) {
  const { doc, signature } = args;
  const message = buildBuyAuthorizationMessage(doc);
  const buyerAddress = verifyMessage(message, signature);
  return { message, buyerAddress };
}

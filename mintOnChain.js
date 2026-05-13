import { Contract, JsonRpcProvider, Wallet, id, isAddress } from "ethers";

/** Matches SimpleNFT.mintTo + IERC721 Transfer for receipt parsing. */
const MINT_TO_ABI = [
  "function mintTo(address recipient, string tokenURI) external returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

function requireMintEnv() {
  const rpcUrl = "https://sepolia.infura.io/v3/a8a267281d30481db7a55bfbac98225f";
  const contractAddress = "0x4d87B56E9B4c3EdF19Cc98B3a4db4707978631eB";
  const privateKey = "867397b37b541fea852295e96bcc4193b34ba948fe32ec742d64954796c9fc5b"
  const missing = [];
  if (!rpcUrl) missing.push("RPC_URL");
  if (!contractAddress) missing.push("CONTRACT_ADDRESS");
  if (!privateKey) missing.push("PRIVATE_KEY");
  if (missing.length) {
    throw new Error(
      `Missing env for on-chain mint: ${missing.join(", ")}. Set them in backend/.env`,
    );
  }
  return { rpcUrl, contractAddress, privateKey };
}

/**
 * @param {{ recipientAddress: string; tokenURI: string; priceWei: bigint }} args
 * `priceWei` is kept for API/DB use; SimpleNFT.mintTo only receives recipient + tokenURI on-chain.
 */
export async function mintNftToRecipient(args) {
  const { recipientAddress, tokenURI, priceWei } = args;
  if (!isAddress(recipientAddress)) {
    throw new Error("Invalid recipient address");
  }
  if (typeof tokenURI !== "string" || !tokenURI.trim()) {
    throw new Error("tokenURI is required");
  }
  if (typeof priceWei !== "bigint" || priceWei < 0n) {
    throw new Error("priceWei must be a non-negative bigint");
  }

  const { rpcUrl, contractAddress, privateKey } = requireMintEnv();
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);
  const contract = new Contract(contractAddress, MINT_TO_ABI, wallet);

  const code = await provider.getCode(contractAddress);
  if (!code || code === "0x") {
    throw new Error(
      `No contract at CONTRACT_ADDRESS ${contractAddress} for this RPC (wrong address, wrong network, or not deployed). Fix RPC_URL / CONTRACT_ADDRESS.`,
    );
  }

  const tx = await contract.mintTo(recipientAddress, tokenURI.trim());
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Transaction receipt unavailable");
  }

  const chainId = Number((await provider.getNetwork()).chainId);
  const txHash = receipt.hash ?? receipt.transactionHash;
  const iface = contract.interface;
  const addrLower = contractAddress.toLowerCase();
  let tokenId = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== addrLower) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Transfer" && parsed.args?.tokenId != null) {
        tokenId = Number(parsed.args.tokenId);
        break;
      }
    } catch {
      // OZ ERC721: all args indexed → tokenId in topics[3]
      if (log.topics.length >= 4) {
        tokenId = Number(BigInt(log.topics[3]));
        break;
      }
    }
  }
  if (tokenId == null || Number.isNaN(tokenId)) {
    throw new Error(
      `Mint tx ${txHash} mined but could not read tokenId from ERC721 Transfer logs. ` +
        `Check CONTRACT_ADDRESS matches SimpleNFT (or compatible ERC721) on this chain.`,
    );
  }

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    chainId,
    contractAddress: contractAddress.toLowerCase(),
    tokenId,
    minterAddress: wallet.address.toLowerCase(),
  };
}

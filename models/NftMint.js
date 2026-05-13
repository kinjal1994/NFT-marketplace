import mongoose from "mongoose";

const nftMintSchema = new mongoose.Schema(
  {
    recipientAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    tokenURI: { type: String, required: true, trim: true },
    metadataGatewayUrl: { type: String, trim: true, default: null },
    imageGatewayUrl: { type: String, trim: true, default: null },
    title: { type: String, trim: true, default: null },
    description: { type: String, trim: true, default: null },
    contractAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    chainId: { type: Number, required: true, index: true },
    tokenId: { type: Number, required: true, index: true },
    txHash: { type: String, required: true, unique: true, trim: true },
    minterAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    priceWei: { type: String, required: true, trim: true },
    blockNumber: { type: Number, default: null },
  },
  { timestamps: true },
);

nftMintSchema.index(
  { contractAddress: 1, chainId: 1, tokenId: 1 },
  { unique: true },
);

export const NftMint =
  mongoose.models.NftMint || mongoose.model("NftMint", nftMintSchema);

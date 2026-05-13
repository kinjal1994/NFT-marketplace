import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import { formatEther } from "ethers";
import {
  assertPinataConfig,
  pinFileBuffer,
  pinNftMetadataJson,
} from "./pinata.js";
import { NftMint } from "./models/NftMint.js";
import { mintNftToRecipient } from "./mintOnChain.js";
import {
  buildBuyAuthorizationMessage,
  recoverBuyerFromBuySignature,
} from "./buyAuthMessage.js";

const PORT = process.env.PORT || 5000;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nft";

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : defaultOrigins;

const app = express();
app.use(
  cors({
    origin: corsOrigins,
    credentials: false,
  }),
);
app.use(express.json());

/** Stored tokenURI, or ipfs:// derived from legacy metadataGatewayUrl (Pinata gateway). */
function listingTokenUri(doc) {
  const raw = doc?.tokenURI;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const gw =
    typeof doc?.metadataGatewayUrl === "string" && doc.metadataGatewayUrl.trim()
      ? doc.metadataGatewayUrl.trim()
      : "";
  const m = gw.match(/\/ipfs\/([^/?#]+)/i);
  if (m) return `ipfs://${m[1]}`;
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image uploads are allowed"));
  },
});

app.get("/", (_req, res) => {
  res.json({ message: "NFT API", database: "nft" });
});

app.get("/api/collections", async (_req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Database is not connected" });
    return;
  }
  try {
    const docs = await NftMint.find().sort({ createdAt: -1 }).lean();
    const nfts = docs.map((d) => {
      const name =
        typeof d.title === "string" && d.title.trim()
          ? d.title.trim()
          : `Token #${d.tokenId}`;
      const image =
        typeof d.imageGatewayUrl === "string" && d.imageGatewayUrl.trim()
          ? d.imageGatewayUrl.trim()
          : `https://picsum.photos/seed/${String(d.txHash).slice(0, 16)}/480/480`;
      let priceEth = "0";
      try {
        priceEth = formatEther(d.priceWei || "0");
      } catch {
        priceEth = "0";
      }
      return {
        id: String(d._id),
        name,
        image,
        priceEth,
        tokenURI: d.tokenURI,
        priceWei: String(d.priceWei ?? "0"),
        contractAddress: d.contractAddress,
        chainId: d.chainId,
        tokenId: d.tokenId,
        txHash: d.txHash,
        description:
          typeof d.description === "string" && d.description.trim()
            ? d.description.trim()
            : null,
      };
    });
    res.json({ nfts });
  } catch (err) {
    console.error("GET /api/collections failed:", err?.message ?? err);
    res.status(500).json({ error: "Failed to load collections" });
  }
});

app.get("/api/nft/buy/challenge", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Database is not connected" });
    return;
  }
  const listingId = String(req.query?.listingId ?? "").trim();
  if (!listingId || !mongoose.isValidObjectId(listingId)) {
    res.status(400).json({ error: "listingId must be a valid MongoDB id" });
    return;
  }
  try {
    const doc = await NftMint.findById(listingId).lean();
    if (!doc) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    const message = buildBuyAuthorizationMessage(doc);
    res.json({
      message,
      contractAddress: doc.contractAddress,
      chainId: doc.chainId,
      tokenURI: listingTokenUri(doc),
      priceWei: String(doc.priceWei ?? "0"),
    });
  } catch (err) {
    console.error("GET /api/nft/buy/challenge failed:", err?.message ?? err);
    res.status(500).json({ error: "Failed to build buy challenge" });
  }
});

app.post("/api/nft/buy/verify", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Database is not connected" });
    return;
  }
  const listingId = String(req.body?.listingId ?? "").trim();
  const signature = String(req.body?.signature ?? "").trim();
  if (!listingId || !mongoose.isValidObjectId(listingId)) {
    res.status(400).json({ error: "listingId must be a valid MongoDB id" });
    return;
  }
  if (!signature) {
    res.status(400).json({ error: "signature is required" });
    return;
  }
  try {
    const doc = await NftMint.findById(listingId).lean();
    if (!doc) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }
    let buyerAddress;
    try {
      ({ buyerAddress } = recoverBuyerFromBuySignature({ doc, signature }));
    } catch (e) {
      res.status(400).json({
        error: "Invalid signature",
        detail: e?.shortMessage || e?.message || String(e),
      });
      return;
    }
    res.json({
      ok: true,
      buyerAddress,
      contractAddress: doc.contractAddress,
      chainId: doc.chainId,
      tokenURI: listingTokenUri(doc),
      priceWei: String(doc.priceWei ?? "0"),
    });
  } catch (err) {
    console.error("POST /api/nft/buy/verify failed:", err?.message ?? err);
    res.status(500).json({ error: "Signature verification failed" });
  }
});

// app.get("/health", (_req, res) => {
//   const ready = mongoose.connection.readyState === 1;
//   res.json({ ok: true, mongodb: ready ? "connected" : "not connected" });
// });

app.post(
  "/api/collection/ipfs-metadata",
  (req, res, next) => {
    upload.single("image")(req, res, (err) => {
      if (err) {
        const message =
          err instanceof multer.MulterError
            ? err.message
            : err.message || "Upload failed";
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      assertPinataConfig();
    } catch (e) {
      res.status(500).json({ error: e.message });
      return;
    }

    const title = String(req.body?.title ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    if (!title || !description) {
      res.status(400).json({ error: "title and description are required" });
      return;
    }
    if (!req.file?.buffer) {
      res.status(400).json({ error: "image file is required" });
      return;
    }

    try {
      const imageCid = await pinFileBuffer(
        req.file.buffer,
        req.file.originalname || "cover",
        req.file.mimetype,
      );
      const imageIpfsUri = `ipfs://${imageCid}`;
      const metadataCid = await pinNftMetadataJson({
        name: title,
        description,
        image: imageIpfsUri,
      });
      const tokenURI = `ipfs://${metadataCid}`;
      res.json({
        tokenURI,
        imageCid,
        metadataCid,
        imageGatewayUrl: `https://gateway.pinata.cloud/ipfs/${imageCid}`,
        metadataGatewayUrl: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
      });
    } catch (err) {
      console.error("Pinata upload failed:", err.message);
      const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 502;
      res.status(status).json({
        error: err.message || "Pinata request failed",
      });
    }
  },
);

function parsePriceWei(raw) {
  if (raw === undefined || raw === null || raw === "") return 0n;
  const s = String(raw).trim();
  if (!s) return 0n;
  if (!/^\d+$/.test(s)) {
    throw new Error("priceWei must be a non-negative integer string (wei)");
  }
  return BigInt(s);
}

app.post("/api/collection/mint", async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ error: "Database is not connected" });
    return;
  }

  const recipientAddress = String(req.body?.recipientAddress ?? "").trim();
  const tokenURI = String(req.body?.tokenURI ?? "").trim();
  const metadataGatewayUrl =
    typeof req.body?.metadataGatewayUrl === "string"
      ? req.body.metadataGatewayUrl.trim() || null
      : null;
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() || null : null;
  const description =
    typeof req.body?.description === "string"
      ? req.body.description.trim() || null
      : null;
  const imageGatewayUrl =
    typeof req.body?.imageGatewayUrl === "string"
      ? req.body.imageGatewayUrl.trim() || null
      : null;

  if (!recipientAddress || !tokenURI) {
    res
      .status(400)
      .json({ error: "recipientAddress and tokenURI are required" });
    return;
  }

  let priceWei;
  try {
    priceWei = parsePriceWei(req.body?.priceWei);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  try {

    console.log("minting nft to recipient", recipientAddress, tokenURI, priceWei);

    const onChain = await mintNftToRecipient({
      recipientAddress,
      tokenURI,
      priceWei,
    });

    console.log("nft onChain Done", onChain);

    const doc = await NftMint.create({
      recipientAddress: recipientAddress.toLowerCase(),
      tokenURI,
      metadataGatewayUrl,
      imageGatewayUrl,
      title,
      description,
      contractAddress: onChain.contractAddress,
      chainId: onChain.chainId,
      tokenId: onChain.tokenId,
      txHash: onChain.txHash,
      minterAddress: onChain.minterAddress,
      priceWei: priceWei.toString(),
      blockNumber: onChain.blockNumber ?? null,
    });

    console.log("nft doc created on DB...", doc);

    res.json({
      ok: true,
      nft: {
        id: doc.id,
        recipientAddress: doc.recipientAddress,
        tokenURI: doc.tokenURI,
        metadataGatewayUrl: doc.metadataGatewayUrl,
        title: doc.title,
        description: doc.description,
        imageGatewayUrl: doc.imageGatewayUrl,
        contractAddress: doc.contractAddress,
        chainId: doc.chainId,
        tokenId: doc.tokenId,
        txHash: doc.txHash,
        minterAddress: doc.minterAddress,
        priceWei: doc.priceWei,
        blockNumber: doc.blockNumber,
        createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    console.error("Mint failed:", err?.message ?? err);
    const msg = err?.shortMessage || err?.message || "Mint failed";
    const status =
      typeof err?.code === "string" && err.code === "INSUFFICIENT_FUNDS"
        ? 502
        : 500;
    res.status(status).json({ error: String(msg) });
  }
});

async function start() {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    const dbName = mongoose.connection.db?.databaseName ?? "nft";
    console.log(`MongoDB connected (database: ${dbName})`);
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    console.error(
      "IPFS routes may work; /api/collection/mint requires MongoDB. Set MONGODB_URI or start MongoDB.",
    );
  }

  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});

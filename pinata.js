const PIN_FILE = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

export function assertPinataConfig() {
  const jwt = process.env.PINATA_JWT?.trim();
  const key = process.env.PINATA_API_KEY?.trim();
  const secret = process.env.PINATA_SECRET_API_KEY?.trim();
  if (!jwt && (!key || !secret)) {
    throw new Error(
      "Set PINATA_JWT or both PINATA_API_KEY and PINATA_SECRET_API_KEY in backend/.env",
    );
  }
}

function pinataAuthHeaders() {
  const jwt = process.env.PINATA_JWT?.trim();
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  return {
    pinata_api_key: process.env.PINATA_API_KEY.trim(),
    pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY.trim(),
  };
}

async function readPinataError(res, text) {
  try {
    const data = JSON.parse(text);
    return (
      data.error?.details ||
      data.error?.reason ||
      data.error ||
      data.message ||
      res.statusText
    );
  } catch {
    return text || res.statusText;
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimeType
 * @returns {Promise<string>} IPFS CID (v0 Qm… or v1 bafy…)
 */
export async function pinFileBuffer(buffer, filename, mimeType) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: mimeType || "application/octet-stream" }),
    filename,
  );
  form.append("pinataMetadata", JSON.stringify({ name: filename }));

  const res = await fetch(PIN_FILE, {
    method: "POST",
    headers: pinataAuthHeaders(),
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(await readPinataError(res, text));
    err.statusCode = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.IpfsHash) {
    throw new Error("Pinata pinFileToIPFS response missing IpfsHash");
  }
  return data.IpfsHash;
}

/**
 * Pins ERC-721–style metadata JSON (name, description, image).
 * @param {{ name: string; description: string; image: string }} content
 * @returns {Promise<string>} IPFS CID of the metadata JSON
 */
export async function pinNftMetadataJson(content) {
  const body = {
    pinataContent: {
      name: content.name,
      description: content.description,
      image: content.image,
    },
    pinataMetadata: { name: "collection-metadata.json" },
  };

  const res = await fetch(PIN_JSON, {
    method: "POST",
    headers: {
      ...pinataAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(await readPinataError(res, text));
    err.statusCode = res.status;
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.IpfsHash) {
    throw new Error("Pinata pinJSONToIPFS response missing IpfsHash");
  }
  return data.IpfsHash;
}

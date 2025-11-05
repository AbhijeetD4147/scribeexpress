const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const https = require("https"); // 👈 add this
const crypto = require("crypto");
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");

const router = express.Router();
const upload = multer();

const PYTHON_API_BASE = process.env.PYTHON_API_BASE || "https://evaascribeprod.maximeyes.com/Scribe";

// 👇 Create an HTTPS agent to ignore invalid SSL in development
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // ⚠️ disables SSL cert verification (DEV ONLY)
});

// Helper: build BlobServiceClient from env
function getBlobServiceClient() {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const sasToken = process.env.AZURE_STORAGE_SAS_TOKEN;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  }
  if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    return new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  }
  if (accountName && sasToken) {
    const sasPrefix = sasToken.startsWith('?') ? '' : '?';
    return new BlobServiceClient(`https://${accountName}.blob.core.windows.net${sasPrefix}${sasToken}`);
  }
  throw new Error('Azure Storage not configured. Set connection string, or account+key, or account+SAS token.');
}

router.post("/process_audio_upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // NEW: pick up Rid and AccountId for Azure upload path
    const rid = Number(req.body?.rid ?? req.query?.rid ?? 0);
    const accountId = String(req.body?.accountId ?? req.query?.accountId ?? "").trim();
    const fileName = String(req.body?.fileName ?? req.file.originalname ?? "audio.ogg").trim();

    // Prepare form data for Python API
    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: fileName,
      contentType: req.file.mimetype,
    });

    // NEW: Fire-and-forget Azure upload, using accountId/rid/guid.ogg
    if (Number.isFinite(rid) && rid > 0 && accountId) {
      const containerName = process.env.AZURE_CONTAINER_NAME || "audio-chunks";
      const guid = crypto.randomUUID();
      const blobName = `${accountId}/${rid}/${guid}.ogg`;

      (async () => {
        try {
          const blobServiceClient = getBlobServiceClient();
          const containerClient = blobServiceClient.getContainerClient(containerName);
          await containerClient.createIfNotExists();
          const blockBlobClient = containerClient.getBlockBlobClient(blobName);
          await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: req.file.mimetype || "audio/ogg" },
          });
          console.log(`[process_audio_upload] Azure upload completed -> ${blobName}`);
        } catch (azureErr) {
          console.error("[process_audio_upload] Azure upload failed:", azureErr);
        }
      })();
    } else {
      console.warn("[process_audio_upload] Skipping Azure upload: rid/accountId missing or invalid.", { rid, accountId });
    }

    // Forward to Python API
    const targetUrl = `${PYTHON_API_BASE}/process_audio_upload`;
    const resp = await axios.post(targetUrl, fd, {
      headers: {
        ...fd.getHeaders(),
        Accept: "application/json",
      },
      httpsAgent, // 👈 attach the custom agent here
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    // Normalize response to always return JSON
    const normalize = (raw) => {
      if (raw == null) return { message: "Empty response from processing service" };
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          const isHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
          return isHtml
            ? { error: "Upstream returned HTML", html: raw }
            : { message: raw };
        }
      }
      return raw;
    };

    const payload = normalize(resp.data);
    return res.status(resp.status).json(payload);
  } catch (err) {
    console.error("[audio process] proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

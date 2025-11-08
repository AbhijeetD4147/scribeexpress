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

    // Accept both 'recordingId' (preferred) and 'rid' for compatibility
    const recordingId =
      Number(req.body?.recordingId ?? req.query?.recordingId ?? req.body?.rid ?? req.query?.rid ?? 0);
    const accountId = String(req.body?.accountId ?? req.query?.accountId ?? "").trim();
    const fileName = String(req.body?.fileName ?? req.file.originalname ?? "audio.ogg").trim();
    const lowerName = fileName.toLowerCase();
    const isWav = lowerName.endsWith(".wav") || (req.file.mimetype || "").includes("wav");
    const contentType = isWav ? "audio/wav" : "audio/ogg";

    // NEW: build FormData for Python processing API
    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: fileName,
      contentType: req.file.mimetype || contentType,
    });

    // NEW: keep track of an Azure GUID (for RECORDING_GUID)
    let recordingGuid = null;

    // NEW: Fire-and-forget Azure upload, using accountId/recordingId/guid (no extension)
    if (Number.isFinite(recordingId) && recordingId > 0 && accountId) {
      const containerName = process.env.AZURE_CONTAINER_NAME || "audio-chunks";
      const incomingGuidRaw = String(
        req.body?.recordingGuid ??
          req.query?.recordingGuid ??
          req.body?.RECORDING_GUID ??
          req.query?.RECORDING_GUID ??
          ""
      ).trim();
      const guid = incomingGuidRaw || crypto.randomUUID();
      recordingGuid = guid;
      const blobName = `${accountId}/${recordingId}/${guid}`; // store WITHOUT extension

      (async () => {
        try {
          const blobServiceClient = getBlobServiceClient();
          const containerClient = blobServiceClient.getContainerClient(containerName);
          await containerClient.createIfNotExists();
          const blockBlobClient = containerClient.getBlockBlobClient(blobName);
          await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: contentType },
          });
          console.log(`[process_audio_upload] Azure upload completed -> ${blobName}`);
        } catch (azureErr) {
          console.error("[process_audio_upload] Azure upload failed:", azureErr);
        }
      })();
    } else {
      console.warn("[process_audio_upload] Skipping Azure upload: recordingId/accountId missing or invalid.", { recordingId, accountId });
    }

    // Forward to Python API
    const targetUrl = `${PYTHON_API_BASE}/process_audio_upload`;
    const resp = await axios.post(targetUrl, fd, {
      headers: {
        ...fd.getHeaders(),
        Accept: "application/json",
      },
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

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

    // NEW: Build AIS_RECORDING payload and call recording-upload internally
    try {
      const aIS_RECORDING = {
        RECORDING_ID: recordingId,
        ENCOUNTER_ID: Number.parseInt(String(req.body?.encounterId ?? 0), 10),
        RECORDING_NAME: fileName,
        RECORDING_GUID: String(recordingGuid ?? ""),
        PATIENT_ID: String(req.body?.patientId ?? ""),
        DOCTOR_ID: String(req.body?.doctorId ?? ""),
        EXPORTED_TO_ENC: false,
        RECORDING_LENGTH: String(req.body?.recordingLength ?? ""),
        IS_FINALIZED: String(req.body?.isFinalized ?? "false") === "true",
        IS_REVIEWED: String(req.body?.isReviewed ?? "false") === "true",
        IS_TRANSCRIPTION_READY: String(req.body?.isTranscriptionReady ?? "false") === "true",
        PATIENT_CONSENT_RECEIVED: String(req.body?.patientConsentReceived ?? "false") === "true",
        USER_ID: Number.parseInt(String(req.body?.userId ?? 0), 10),
        IS_PARTIAL: String(req.body?.isPartial ?? "false") === "true",
        // Pass Python response to allow SOAP/DICTATION post-saves
        jsonResponse: payload,
        // Optional: allow body-based accountId (in addition to query)
        accountId: accountId,
      };

      const internalUrl = `${req.protocol}://${req.get("host")}/api/FileUpload/recording-upload`;
      const apiKeyHeader =
        req.headers.apikey || req.headers["x-api-key"] || req.headers["apiKey"] || undefined;

      const saveResp = await axios.post(
        internalUrl,
        aIS_RECORDING,
        {
          headers: {
            "content-type": "application/json",
            accept: "*/*",
            ...(apiKeyHeader ? { apikey: String(apiKeyHeader) } : {}),
          },
          params: { accountId },
          httpsAgent,
          validateStatus: () => true,
        }
      );
      console.log(`[process_audio_upload] recording-upload <- ${saveResp.status} ${saveResp.statusText}`);
    } catch (saveErr) {
      console.error("[process_audio_upload] recording-upload internal call failed:", saveErr?.message || saveErr);
    }

    // Return Python payload to client (unchanged behavior)
    return res.status(resp.status).json(payload);
  } catch (err) {
    console.error("[audio process] proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

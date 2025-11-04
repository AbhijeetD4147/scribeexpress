// Module: audiofileretrieve
const express = require("express");
const router = express.Router();
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  ContainerClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");



router.get("/merged-audio-url", async (req, res) => {
  const { recordingId, accountId } = req.query;

  const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || "prodaichatbotstorage";
  const CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME || "audio-chunks";
  const STORAGE_KEY = (process.env.AZURE_STORAGE_KEY || "").trim();

  // Normalize SAS: trim spaces and strip leading '?'
  const AZURE_STORAGE_SAS_TOKEN = process.env.AZURE_STORAGE_SAS_TOKEN || "";
  const SAS = AZURE_STORAGE_SAS_TOKEN.trim().replace(/^\?/, "");

  if (!recordingId || !accountId) {
    return res.status(400).json({ error: "Missing recordingId or accountId" });
  }

  // Optional fast-path: client can pass known blobPath to skip listing
  const blobPathParam = typeof req.query.blobPath === "string" ? req.query.blobPath.replace(/^\/+/, "") : "";

  try {
    let containerClient;

    if (STORAGE_KEY) {
      // Use account key for robust auth (no SAS required for listing)
      const creds = new StorageSharedKeyCredential(STORAGE_ACCOUNT, STORAGE_KEY);
      const serviceClient = new BlobServiceClient(
        `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
        creds
      );
      containerClient = serviceClient.getContainerClient(CONTAINER_NAME);
    } else if (SAS) {
      // Fallback: use provided SAS (requires sp=rl to list)
      const containerUrl = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER_NAME}?${SAS}`;
      containerClient = new ContainerClient(containerUrl);
    } else if (blobPathParam) {
      // If we only need to build a URL and have the blob path, we can return with SAS if present
      const url = SAS
        ? `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER_NAME}/${blobPathParam}?${SAS}`
        : `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER_NAME}/${blobPathParam}`;
      return res.json({ url });
    } else {
      return res.status(500).json({
        error: "No Azure credentials configured",
        details:
          "Configure AZURE_STORAGE_KEY for server-side listing, or a SAS with sp=rl, or pass blobPath.",
      });
    }

    let blobName = blobPathParam || null;

    // If blob path not provided, list to find first .ogg under prefix
    if (!blobName) {
      const prefix = `${accountId}/${recordingId}`;
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        if (blob.name.toLowerCase().endsWith(".ogg")) {
          blobName = blob.name;
          break;
        }
      }
    }

    if (!blobName) {
      return res.json({ url: null });
    }

    // Build final playable URL
    if (STORAGE_KEY) {
      // Generate a short-lived blob SAS with read permission
      const creds = new StorageSharedKeyCredential(STORAGE_ACCOUNT, STORAGE_KEY);
      const startsOn = new Date(Date.now() - 5 * 60 * 1000); // 5 min clock skew allowance
      const expiresOn = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      const sasParams = generateBlobSASQueryParameters(
        {
          containerName: CONTAINER_NAME,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
          startsOn,
          expiresOn,
        },
        creds
      ).toString();

      const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}?${sasParams}`;
      return res.json({ url, blobPath: blobName });
    }

    // If using provided SAS, return URL with it
    const url = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}?${SAS}`;
    return res.json({ url, blobPath: blobName });
  } catch (err) {
    const status = err?.statusCode || err?.response?.status || 500;
    const code = err?.code || err?.details?.errorCode || "UnknownError";
    const msg = err?.message || "Failed to retrieve merged audio URL";

    const hints = [];
    if (!STORAGE_KEY && SAS) {
      const hasSig = /\bsig=/.test(SAS);
      const hasSp = /\bsp=/.test(SAS);
      const hasRl = /\bsp=.*r.*l/.test(SAS);
      if (!hasSig) hints.push("SAS missing 'sig' signature");
      if (!hasSp) hints.push("SAS missing 'sp' permissions");
      if (!hasRl) hints.push("SAS should include read+list (sp=rl)");
      if (!/\bss=b\b/.test(SAS)) hints.push("Include 'ss=b' (blob service)");
      if (!/\bsrt=sco\b/.test(SAS)) hints.push("Include 'srt=sco' (service, container, object)");
      if (!/\bspr=https\b/.test(SAS)) hints.push("Include 'spr=https'");
      if (!/\bse=/.test(SAS)) hints.push("Ensure 'se' (expiry) not expired");
    }
    if (!STORAGE_KEY) hints.push("Prefer configuring AZURE_STORAGE_KEY for server-side auth");

    console.error("[merged-audio-url] error:", { status, code, msg, hints });
    return res.status(status).json({
      error: "Failed to retrieve merged audio URL",
      code,
      details: msg,
      hints,
    });
  }
});

module.exports = router;
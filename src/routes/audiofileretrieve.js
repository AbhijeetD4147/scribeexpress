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

  // Optional fast-paths from client
  const blobPathParam = typeof req.query.blobPath === "string" ? req.query.blobPath.replace(/^\/+/, "") : "";
  const guidParamRaw = String(req.query.guid ?? req.query.RECORDING_GUID ?? "").trim();
  const guidParam = guidParamRaw ? guidParamRaw.replace(/^\//, "") : "";

  // NEW: allow caller to prefer a format (wav or ogg)
  const formatRaw = String(req.query.format ?? "").toLowerCase();
  const preferredExt = formatRaw === "wav" ? "wav" : formatRaw === "ogg" ? "ogg" : null;

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

    // Prefer explicit blob path or GUID-derived path
    let blobName = blobPathParam || null;

    // Helper to resolve by trying candidate names
    const tryResolveByCandidates = async (candidates) => {
      for (const name of candidates) {
        const blobClient = containerClient.getBlobClient(name);
        try {
          const exists = await blobClient.exists();
          if (exists) return name;
        } catch {
          // ignore and continue
        }
      }
      return null;
    };

    if (!blobName && guidParam) {
      const base = `${accountId}/${recordingId}/${guidParam.replace(/\.(ogg|wav)$/i, "")}`;
      const candidates = preferredExt
        ? [`${base}.${preferredExt}`]
        : [`${base}.wav`, `${base}.ogg`];
      blobName = await tryResolveByCandidates(candidates);
    }

    // If blob path not provided and no GUID or not found, list under prefix
    // if (!blobName) {
    //   const prefix = `${accountId}/${recordingId}`;
    //   let foundWav = null;
    //   let foundOgg = null;
    //   for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    //     const name = blob.name.toLowerCase();
    //     if (name.endsWith(".wav") && !foundWav) foundWav = blob.name;
    //     if (name.endsWith(".ogg") && !foundOgg) foundOgg = blob.name;
    //     // Short-circuit if preferred found
    //     if (preferredExt === "wav" && foundWav) break;
    //     if (preferredExt === "ogg" && foundOgg) break;
    //   }
    //   blobName =
    //     preferredExt === "wav" ? (foundWav || foundOgg) :
    //     preferredExt === "ogg" ? (foundOgg || foundWav) :
    //     (foundWav || foundOgg);
    // }


        // If blob path not provided and no GUID or not found, list under prefix
    if (!blobName) {
      const prefix = `${accountId}/${recordingId}`;
      let latestBlob = null;

      // list all blobs under the prefix
      for await (const blob of containerClient.listBlobsFlat({ prefix })) {
        const name = blob.name.toLowerCase();
        const isAudio = name.endsWith(".wav") || name.endsWith(".ogg");

        if (!isAudio) continue; // skip non-audio

        // Check if preferred extension matches (if specified)
        if (preferredExt && !name.endsWith(`.${preferredExt}`)) continue;

        // Keep the newest blob by lastModified timestamp
        if (!latestBlob || blob.properties.lastModified > latestBlob.properties.lastModified) {
          latestBlob = blob;
        }
      }

      // fallback: if no preferredExt found, try any audio file
      if (!latestBlob && !preferredExt) {
        for await (const blob of containerClient.listBlobsFlat({ prefix })) {
          const name = blob.name.toLowerCase();
          
            if (!latestBlob || blob.properties.lastModified > latestBlob.properties.lastModified) {
              latestBlob = blob;
            }
          
        }
      }

      blobName = latestBlob ? latestBlob.name : null;
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
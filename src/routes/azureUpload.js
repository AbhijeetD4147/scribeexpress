const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function getBlobServiceClient() {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const sasToken =process.env.AZURE_STORAGE_SAS_TOKEN;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  }
  if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    return new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      credential
    );
  }
  if (accountName && sasToken) {
    const sasPrefix = sasToken.startsWith('?') ? '' : '?';
    return new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net${sasPrefix}${sasToken}`
    );
  }
  throw new Error(
    'Azure Storage not configured. Set connection string, or account+key, or account+SAS token.'
  );
}

router.post('/upload-audio', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const recordingId = Number(req.body.recordingId || 0);
    const accountId = String(req.body.accountId || '').trim();
    if (!accountId || !Number.isFinite(recordingId) || recordingId <= 0) {
      return res.status(400).json({ error: 'accountId and valid recordingId required' });
    }

    const blobServiceClient = getBlobServiceClient();
    const containerName = process.env.AZURE_CONTAINER_NAME || 'audio-chunks';
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();

    const guid = crypto.randomUUID();
    const blobName = `${accountId}/${recordingId}/${guid}.ogg`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype || 'audio/ogg' },
    });

    return res.status(200).json({ blobPath: blobName });
  } catch (err) {
    console.error('[azure upload] error:', err);
    return res.status(500).json({ error: 'Azure upload failed', details: err.message });
  }
});

module.exports = router;
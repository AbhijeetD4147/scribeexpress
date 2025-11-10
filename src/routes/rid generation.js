const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const axios = require('axios');
const https = require('https');

function mapToDbType(value) {
  if (value instanceof Date) return 'DateTime';
  const t = typeof value;
  if (t === 'boolean') return 'Bit';
  if (t === 'number') return Number.isInteger(value) ? 'Int32' : 'Decimal';
  if (t === 'string') {
    const d = Date.parse(value);
    if (!Number.isNaN(d) && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'DateTime';
    return 'VarChar';
  }
  return 'VarChar';
}

// Simple in-memory cache for tokens per accountId
const tokenCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mapToDbType(value) {
  if (value instanceof Date) return 'DateTime';
  const t = typeof value;
  if (t === 'boolean') return 'Bit';
  if (t === 'number') return Number.isInteger(value) ? 'Int32' : 'Decimal';
  if (t === 'string') {
    const d = Date.parse(value);
    if (!Number.isNaN(d) && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'DateTime';
    return 'VarChar';
  }
  return 'VarChar';
}

// Sanitize SELF_BASE_URL and ensure no trailing slash
function getSelfBaseUrl() {
  const baseRaw = process.env.SELF_BASE_URL || 'http://localhost:5000';
  const base = String(baseRaw).replace(/`/g, '').trim();
  return base.replace(/\/$/, '');
}

async function acquireApiKey(req, accountId) {
  const incomingApiKey =
    req.headers.apikey || req.headers['x-api-key'] || req.headers['apiKey'] || req.headers['apikey'];
  if (incomingApiKey) return String(incomingApiKey);

  const key = String(accountId || '').trim();
  const now = Date.now();
  const ttlMs = Number(process.env.TOKEN_CACHE_TTL_MS) || 10 * 60 * 1000; // 10 minutes default

  // Return cached token if still valid
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now && cached.token) {
    return `Bearer ${cached.token}`;
  }

  const base = getSelfBaseUrl();
  const tokenUrl = new URL('/api/Customer/GetTokenAsyncNew', base);
  tokenUrl.searchParams.set('accountId', key);

  const isHttps = /^https:/i.test(base);
  const httpsAgent =
    isHttps
      ? new https.Agent({
          keepAlive: true,
          rejectUnauthorized: !(process.env.ALLOW_INSECURE_TLS === 'true'),
        })
      : undefined;

  const timeoutMs = Number(process.env.TOKEN_FETCH_TIMEOUT_MS) || 45000;
  const maxAttempts = Math.max(1, Number(process.env.TOKEN_FETCH_RETRIES) || 3);

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get(tokenUrl.toString(), {
        headers: { accept: '*/*' },
        httpsAgent,
        timeout: timeoutMs,
        validateStatus: () => true,
      });

      if (resp.status < 200 || resp.status >= 300) {
        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        throw new Error(`GetTokenAsyncNew failed: ${resp.status} ${body}`);
      }

      const token =
        typeof resp.data === 'string'
          ? resp.data
          : resp.data?.Token || resp.data?.token || '';

      if (!token) throw new Error('Empty token from GetTokenAsyncNew');

      // Optional: honor upstream TTL if provided; else use default ttlMs
      const upstreamTtlSec =
        (resp.data && (resp.data.expiresInSeconds || resp.data.ttlSeconds)) || null;
      const expiresAt =
        now + (upstreamTtlSec && Number(upstreamTtlSec) > 0 ? Number(upstreamTtlSec) * 1000 : ttlMs);

      tokenCache.set(key, { token, expiresAt });
      return `Bearer ${token}`;
    } catch (err) {
      lastErr = err;
      // ECONNABORTED or network issues: backoff and retry
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        await sleep(backoffMs);
        continue;
      }
      break;
    }
  }

  // If all attempts fail, surface the last error
  throw lastErr || new Error('Token acquisition failed');
}

async function execSaveRecording(req, aisRecording, accountId) {
  const IO_API_BASE = process.env.IO_API_BASE;
  if (!IO_API_BASE) {
    throw new Error('IO_API_BASE not configured');
  }

  const apiKeyHeader = await acquireApiKey(req, accountId);

  const parameters = Object.entries(aisRecording)
    .filter(([_, v]) => v !== null && typeof v !== 'undefined')
    .map(([name, value]) => ({ name, value, dbType: mapToDbType(value) }));

  const payload = {
    ProcedureName: 'AIS_INSERT_UPDATE_AIS_RECORDING',
    Parameters: parameters,
  };

  const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
  const resp = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: '*/*', apiKey: apiKeyHeader },
    body: JSON.stringify(payload),
  });

  const ct = resp.headers.get('content-type') || '';
  if (resp.status < 200 || resp.status >= 300) {
    const text = ct.includes('application/json') ? JSON.stringify(await resp.json()) : await resp.text();
    throw new Error(`ExecStoredProcedure upstream error: ${resp.status} ${text}`);
  }

  let data;
  if (ct.includes('application/json')) {
    data = await resp.json();
  } else {
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  const table = Array.isArray(data?.Table) ? data.Table : [];
  const firstRow = table[0] || null;
  const recordingIdRaw = firstRow ? (firstRow.RECORDING_ID ?? firstRow.recording_id ?? null) : null;
  const parsedRecordingId = recordingIdRaw != null ? Number(recordingIdRaw) : NaN;
  if (!Number.isFinite(parsedRecordingId)) {
    return { Id: null, Message: 'No RECORDING_ID found in response.' };
  }
  return { Id: parsedRecordingId };
}

// POST /api/rid/generate
router.post('/generate', async (req, res) => {
  try {
    const {
      EncounterId,
      FileName,
      PatientId,
      recordingLength,
      Userid,
      AccountId,
      pauseFlag,
    } = req.body || {};

    const recordingGuid = randomUUID();

    const aisRecording = {
      RECORDING_ID: 0,
      ENCOUNTER_ID: EncounterId,
      RECORDING_NAME: FileName,
      RECORDING_GUID: recordingGuid,
      PATIENT_ID: PatientId,
      DOCTOR_ID: 0,
      EXPORTED_TO_ENC: 0,
      RECORDING_LENGTH: stringify(recordingLength),
      IS_FINALIZED: false,
      IS_REVIEWED: 0,
      IS_TRANSCRIPTION_READY: 1,
      PATIENT_CONSENT_RECEIVED: 0,
      USER_ID: Number(Userid ?? 0),
      IS_PARTIAL: pauseFlag ? 1 : 0,
    };

    const saveRecording = await execSaveRecording(req, aisRecording, AccountId);
    return res.status(200).json({
      Code: 200,
      Rid: saveRecording.Id,
      message: 'Partial Recording inserted.',
    });
  } catch (err) {
    console.error('[rid/generate] error:', err);
    return res.status(500).json({ error: 'RID generation failed', details: err.message });
  }
});

module.exports = router;
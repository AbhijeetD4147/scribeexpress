const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');

const IO_API_BASE = process.env.IO_API_BASE;

router.post('/', async (req, res) => {
  try {
    // Parse recordingId from either { recordingId } or ExecStoredProcedure-shaped payload
    let recordingId = req.body?.recordingId;
    if (!recordingId && req.body && typeof req.body === 'object') {
      const { ProcedureName, Parameters } = req.body;
      const isDictationProc =
        typeof ProcedureName === 'string' &&
        ProcedureName.toUpperCase() === 'AIS_GET_AIS_DICTATION';
      if (isDictationProc && Array.isArray(Parameters)) {
        const recParam = Parameters.find(
          (p) => String(p.name).toUpperCase() === 'RECORDING_ID'
        );
        recordingId = recParam?.value;
      }
    }

    const idNum = Number(recordingId);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'recordingId required' });
    }
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    // Prefer incoming apiKey header if present; fallback to ensured token
    const incomingApiKey =
      req.headers.apikey ||
      req.headers['x-api-key'] ||
      req.headers['apiKey']; // note: headers are lowercased by Node
    const token = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    const body = {
      ProcedureName: 'AIS_GET_AIS_DICTATION',
      Parameters: [{ name: 'RECORDING_ID', value: idNum, dbType: 'Int32' }],
    };

    console.log(
      `[dictation proxy] ${req.method} ${req.originalUrl} -> ${target} recordingId=${idNum} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`
    );

    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        apiKey: token, // upstream typically expects 'apiKey' Bearer
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      // Attempt to refresh token on unauthorized
      invalidateIoToken();
    }

    const ct = resp.headers.get('content-type') || '';
    console.log(`[dictation proxy] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    } else {
      const text = await resp.text();
      return res.send(text);
    }
  } catch (err) {
    console.error('[dictation proxy] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
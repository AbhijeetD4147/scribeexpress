const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');

const IO_API_BASE = process.env.IO_API_BASE;

router.post('/', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    const bodyIn = req.body || {};
    let recordingId = bodyIn.recordingId;
    let isFinalized = bodyIn.isFinalized;

    if (recordingId == null || typeof isFinalized === 'undefined') {
      const { ProcedureName, Parameters } = bodyIn;
      const isTargetProc =
        typeof ProcedureName === 'string' &&
        ProcedureName.toUpperCase() === 'AIS_UPDATE_FINALISE_SCRIBE_NOTES';
      if (isTargetProc && Array.isArray(Parameters)) {
        const rid = Parameters.find(p => String(p.name).toUpperCase() === 'RECORDING_ID');
        const fin = Parameters.find(p => String(p.name).toUpperCase() === 'ISFINALIZE');
        recordingId = rid?.value;
        isFinalized = fin?.value;
      }
    }

    const idNum = Number(recordingId);
    const finalizedBool = (isFinalized === true || isFinalized === 'true' || isFinalized === 1 || isFinalized === '1');
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'recordingId required' });
    }

    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    const payload = {
      ProcedureName: 'AIS_UPDATE_FINALISE_SCRIBE_NOTES',
      Parameters: [
        { name: 'RECORDING_ID', value: idNum, dbType: 'Int32' },
        { name: 'IsFinalize', value: finalizedBool, dbType: 'Bit' },
      ],
    };

    console.log(`[finalize proxy] POST ${req.originalUrl} -> ${target} recordingId=${idNum} isFinalized=${finalizedBool} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`);

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: tokenHeader },
      body: JSON.stringify(payload),
    });

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    console.log(`[finalize proxy] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[finalize proxy] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

// New GET endpoint matching UpsertRecording(RECORDING_ID, IsFinalize)
router.get('/UpsertRecording', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    const recordingId = req.query.RECORDING_ID ?? req.query.recordingId;
    const isFinalized = req.query.IsFinalize ?? req.query.isFinalized;

    const idNum = Number(recordingId);
    const finalizedBool = (isFinalized === true || isFinalized === 'true' || isFinalized === 1 || isFinalized === '1');

    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'RECORDING_ID required' });
    }

    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    const payload = {
      ProcedureName: 'AIS_UPDATE_FINALISE_SCRIBE_NOTES',
      Parameters: [
        { name: 'RECORDING_ID', value: idNum, dbType: 'Int32' },
        { name: 'IsFinalize', value: finalizedBool, dbType: 'Bit' },
      ],
    };

    console.log(`[finalize proxy GET] GET ${req.originalUrl} -> ${target} recordingId=${idNum} isFinalized=${finalizedBool} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`);

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: tokenHeader },
      body: JSON.stringify(payload),
    });

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[finalize proxy GET] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
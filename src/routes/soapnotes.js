const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');

const IO_API_BASE = process.env.IO_API_BASE;

router.post('/', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    // Accept either simple JSON { recordingId, soapId? } or ExecStoredProcedure-shaped payload
    const bodyIn = req.body || {};
    let recordingId = bodyIn.recordingId;
    let soapId = bodyIn.soapId;

    if (!recordingId) {
      const { ProcedureName, Parameters } = bodyIn;
      const isTargetProc =
        typeof ProcedureName === 'string' &&
        ProcedureName.toUpperCase() === 'AIS_GET_SOAP_NOTES';
      if (isTargetProc && Array.isArray(Parameters)) {
        const rid = Parameters.find(p => String(p.name).toUpperCase() === 'RECORDING_ID');
        const sid = Parameters.find(p => String(p.name).toUpperCase() === 'SOAP_ID');
        recordingId = rid?.value;
        soapId = sid?.value;
      }
    }

    const idNum = Number(recordingId);
    const soapIdNum = Number.isFinite(Number(soapId)) ? Number(soapId) : 0;
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'recordingId required' });
    }

    // Prefer incoming apiKey header; fallback to token manager
    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;

    const payload = {
      ProcedureName: 'AIS_GET_SOAP_NOTES',
      Parameters: [
        { name: 'RECORDING_ID', value: idNum, dbType: 'Int32' },
        { name: 'SOAP_ID', value: soapIdNum, dbType: 'Int32' }
      ]
    };

    console.log(
      `[soapnotes proxy] POST ${req.originalUrl} -> ${target} recordingId=${idNum} soapId=${soapIdNum} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`
    );

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: tokenHeader },
      body: JSON.stringify(payload)
    });

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    console.log(`[soapnotes proxy] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[soapnotes proxy] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
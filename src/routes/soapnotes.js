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

// In POST /api/soapnotes/save handler
router.post('/save', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    // Prefer incoming apiKey header; fallback to token manager
    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    // Accept both `notes` and legacy `soap_note` shapes
    const body = req.body || {};
    let notesArr =
      Array.isArray(body.notes) ? body.notes :
      Array.isArray(body.soap_note) ? body.soap_note :
      Array.isArray(body.NOTES) ? body.NOTES : [];

    // Handle multipart/form-data with bracketed fields like NOTES[0].SOAP_ID
    if ((!notesArr || notesArr.length === 0) && body && typeof body === 'object') {
      const keys = Object.keys(body);
      const bracketed = keys.filter(k => /^(NOTES|soap_note)\[\d+\]\./i.test(k));
      if (bracketed.length) {
        const tmp = {};
        for (const k of bracketed) {
          const m = k.match(/^(NOTES|soap_note)\[(\d+)\]\.(.+)$/i);
          if (!m) continue;
          const [, , idxStr, field] = m;
          const idx = parseInt(idxStr, 10);
          tmp[idx] = tmp[idx] || {};
          tmp[idx][field] = body[k];
        }
        const maxIdx = Math.max(...Object.keys(tmp).map(n => parseInt(n, 10)));
        notesArr = [];
        for (let i = 0; i <= maxIdx; i++) {
          if (tmp[i]) notesArr.push(tmp[i]);
        }
      }
    }

    if (!Array.isArray(notesArr) || notesArr.length === 0) {
      return res.status(400).json({ error: 'notes array is required and cannot be empty' });
    }

    const recordingIdFallback = Number(body.recordingId ?? body.RECORDING_ID ?? 0) || 0;
    const userIdFallback = Number(body.userId ?? body.USER_ID ?? 0) || 0;

    const toBit = (v) => {
      const s = String(v ?? '').trim().toLowerCase();
      return (v === true || s === 'true' || s === '1') ? 1 : 0;
    };

    // TVP rows aligned with your C# implementation
    const tvpRows = notesArr.map((note) => ({
      SOAP_ID: Number(note.SOAP_ID ?? 0),
      RECORDING_ID: Number(note.RECORDING_ID ?? recordingIdFallback),
      ELEMENT_ID: Number(note.ELEMENT_ID ?? 0),
      NOTES: String(note.NOTES ?? ''),
      EXPORTED_TO_ENC: toBit(note.EXPORTED_TO_ENC),
      USER_ID: Number(note.USER_ID ?? userIdFallback),
      JSON_TEXT: String(note.JSON_TEXT ?? ''),
      ELEMENT_NAME: String(note.ELEMENT_NAME ?? ''),
      PATIENT_ID: String(note.PATIENT_ID ?? ''),
      ENCOUNTER_ID: String(note.ENCOUNTER_ID ?? ''),
    }));

    const payload = {
      ProcedureName: 'AIS_INSERT_UPDATE_SOAP_NOTES',
      Parameters: [
        { name: '@TVP_AIS_SOAP_NOTES', value: tvpRows, dbType: 'tvp' },
      ],
    };
    console.log(tvpRows );

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;

    const doPost = async (apiKey) => {
      return fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: '*/*', apiKey },
        body: JSON.stringify(payload),
      });
    };

    let resp = await doPost(tokenHeader);

    // Handle Unauthorized: invalidate and retry once if we manage the token
    if (resp.status === 401 && !incomingApiKey) {
      invalidateIoToken();
      const retryHeader = `Bearer ${await ensureIoToken()}`;
      resp = await doPost(retryHeader);
    }

    const ct = resp.headers.get('content-type') || '';
    if (resp.status < 200 || resp.status >= 300) {
      const text = ct.includes('application/json') ? JSON.stringify(await resp.json()) : await resp.text();
      return res.status(resp.status).json({
        Status: false,
        error: 'Upstream error',
        details: text,
      });
    }

    // Normalize response and mirror your C# return shape
    const data = ct.includes('application/json') ? await resp.json() : await resp.text();
    return res.status(200).json({ Status: true, data });
  } catch (err) {
    console.error('[soapnotes save] error:', err);
    return res.status(502).json({ Status: false, error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
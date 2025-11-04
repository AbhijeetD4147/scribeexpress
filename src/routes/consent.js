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
    let consentReceived = bodyIn.consentReceived;

    if (recordingId == null || typeof consentReceived === 'undefined') {
      const { ProcedureName, Parameters } = bodyIn;
      const isTargetProc =
        typeof ProcedureName === 'string' &&
        ProcedureName.toUpperCase() === 'AIS_UPDATE_PATIENT_CONSENT_RECEIVED_FLAG';
      if (isTargetProc && Array.isArray(Parameters)) {
        const rid = Parameters.find(p => String(p.name).toUpperCase() === 'RECORDING_ID');
        const cons = Parameters.find(p => String(p.name).toUpperCase() === 'PATIENT_CONSENT_RECEIVED');
        recordingId = rid?.value;
        consentReceived = cons?.value;
      }
    }

    const idNum = Number(recordingId);
    const consentBool = (consentReceived === true || consentReceived === 'true' || consentReceived === 1 || consentReceived === '1');
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'recordingId required' });
    }

    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    const payload = {
      ProcedureName: 'AIS_UPDATE_PATIENT_CONSENT_RECEIVED_FLAG',
      Parameters: [
        { name: 'RECORDING_ID', value: idNum, dbType: 'Int32' },
        { name: 'PATIENT_CONSENT_RECEIVED', value: consentBool, dbType: 'Bit' },
      ],
    };

    console.log(`[consent proxy] POST ${req.originalUrl} -> ${target} recordingId=${idNum} consent=${consentBool} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`);

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: tokenHeader },
      body: JSON.stringify(payload),
    });

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    console.log(`[consent proxy] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[consent proxy] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

// New GET endpoint: UpdatePatientConsentFlag(RECORDING_ID, IsPatientConsent, accountId?)
router.get('/UpdatePatientConsentFlag', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    const recordingId = req.query.RECORDING_ID ?? req.query.recordingId;
    const isPatientConsent = req.query.IsPatientConsent ?? req.query.patientConsent;
    const idNum = Number(recordingId);
    const consentBool = (isPatientConsent === true || isPatientConsent === 'true' || isPatientConsent === 1 || isPatientConsent === '1');

    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'RECORDING_ID required' });
    }

    // Prefer incoming apiKey header; fallback to token manager
    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    const payload = {
      ProcedureName: 'AIS_UPDATE_PATIENT_CONSENT_RECEIVED_FLAG',
      Parameters: [
        { name: 'RECORDING_ID', value: idNum, dbType: 'Int32' },
        { name: 'PATIENT_CONSENT_RECEIVED', value: consentBool, dbType: 'Bit' },
      ],
    };

    console.log(`[consent proxy GET] GET ${req.originalUrl} -> ${target} recordingId=${idNum} consent=${consentBool} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`);

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
    console.error('[consent proxy GET] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
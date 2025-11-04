const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');

const IO_API_BASE = process.env.IO_API_BASE;

router.post('/', async (req, res) => {
  try {
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    // Accept either simple JSON { startDate, endDate, patientId? } or ExecStoredProcedure-shaped payload
    const bodyIn = req.body || {};
    let startDate = bodyIn.startDate;
    let endDate = bodyIn.endDate;
    let patientId = bodyIn.patientId;

    // If ExecStoredProcedure-shaped, extract values
    if (!startDate || !endDate) {
      const { ProcedureName, Parameters } = bodyIn;
      const isTargetProc =
        typeof ProcedureName === 'string' &&
        ProcedureName.toUpperCase() === 'AIS_GET_AIS_RECORDINGS';
      if (isTargetProc && Array.isArray(Parameters)) {
        const sd = Parameters.find(p => String(p.name).toUpperCase() === 'START_DATE');
        const ed = Parameters.find(p => String(p.name).toUpperCase() === 'END_DATE');
        const pid = Parameters.find(p => String(p.name).toUpperCase() === 'ORDERBYPATIENTID');
        startDate = sd?.value;
        endDate = ed?.value;
        patientId = pid?.value;
      }
    }

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate required' });
    }

    // Prefer incoming apiKey header; fallback to token manager
    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apikey'];
    const tokenHeader = incomingApiKey ? String(incomingApiKey) : `Bearer ${await ensureIoToken()}`;

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;

    const payload = {
      ProcedureName: 'AIS_GET_AIS_RECORDINGS',
      Parameters: [
        { name: 'START_DATE', value: String(startDate), dbType: 'datetime' },
        { name: 'END_DATE', value: String(endDate), dbType: 'datetime' },
        ...(patientId
          ? [{ name: 'OrderByPatientId', value: String(patientId), dbType: 'varchar' }]
          : [])
      ]
    };

    console.log(
      `[recordings proxy] POST ${req.originalUrl} -> ${target} start=${startDate} end=${endDate} pid=${patientId ?? ''} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`
    );

    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: tokenHeader },
      body: JSON.stringify(payload)
    });

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    console.log(`[recordings proxy] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[recordings proxy] error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');
const { ensureAuthToken } = require('../utils/tokenManager');

const AISCRIBE_API_BASE = process.env.AISCRIBE_API_BASE;
if (!AISCRIBE_API_BASE) {
  console.warn('[Maximeyes] AISCRIBE_API_BASE not set; Customer requests will fail.');
}

const IO_API_BASE = process.env.IO_API_BASE;
if (!IO_API_BASE) {
  console.warn('[Maximeyes] IO_API_BASE not set; requests will fail.');
}

// Build target for Customer controller on AIScribe API base
function buildCustomerTarget(path, query) {
  const base = AISCRIBE_API_BASE?.replace(/\/$/, '') || '';
  const p = `${path}`.replace(/^\//, '');
  const url = `${base}/api/Customer/${p}`;
  const qs = new URLSearchParams(query || {}).toString();
  return qs ? `${url}?${qs}` : url;
}

// Normalize incoming auth headers to Authorization
function getAuthHeader(req) {
  const incomingAuth =
    req.headers.authorization ||
    req.headers.apikey ||
    req.headers['x-api-key'] ||
    req.headers['apikey'];
  return incomingAuth ? String(incomingAuth) : null;
}

// Send single soap note
router.post('/SendSoapNoteToMaximeyes', async (req, res) => {
  try {
    const encounterId = req.query.encounterId ?? req.query.EncounterId ?? req.query.id;
    const accountId = req.query.accountId ?? req.query.AccountId;
    const idNum = Number(encounterId);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'encounterId is required as a query parameter' });
    }

    const authHeader = getAuthHeader(req) || `Bearer ${await ensureAuthToken()}`;

    const target = buildCustomerTarget('SendSoapNoteToMaximeyes', {
      encounterId: idNum,
      ...(accountId ? { accountId: String(accountId) } : {}),
    });

    console.log(`[Maximeyes] POST ${req.originalUrl} -> ${target} authHeader=${authHeader ? 'yes' : 'no'} base=${AISCRIBE_API_BASE}`);

    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body || {}),
    });

    const ct = resp.headers.get('content-type') || '';
    console.log(`[Maximeyes] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[Maximeyes] fetch error:', { message: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

// Send all soap notes (bulk)
router.post('/SendAllSoapNoteToMaximeyes', async (req, res) => {
  try {
    const encounterId = req.query.encounterId ?? req.query.EncounterId ?? req.query.id;
    const accountId = req.query.accountId ?? req.query.AccountId;
    const idNum = Number(encounterId);
    if (!Number.isFinite(idNum)) {
      return res.status(400).json({ error: 'encounterId is required as a query parameter' });
    }

    const authHeader = getAuthHeader(req) || `Bearer ${await ensureAuthToken()}`;

    const target = buildCustomerTarget('SendAllSoapNoteToMaximeyes', {
      encounterId: idNum,
      ...(accountId ? { accountId: String(accountId) } : {}),
    });

    console.log(`[Maximeyes ALL] POST ${req.originalUrl} -> ${target} authHeader=${authHeader ? 'yes' : 'no'} base=${AISCRIBE_API_BASE}`);

    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: '*/*',
        Authorization: authHeader,
      },
      body: JSON.stringify(req.body || {}),
    });

    const ct = resp.headers.get('content-type') || '';
    console.log(`[Maximeyes ALL] <- ${resp.status} content-type=${ct}`);

    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    }
    const text = await resp.text();
    return res.send(text);
  } catch (err) {
    console.error('[Maximeyes ALL] fetch error:', { message: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
});

module.exports = router;
const express = require('express');
const router = express.Router();
const { ensureIoToken, invalidateIoToken } = require('../utils/tokenManager');

const IO_API_BASE = process.env.IO_API_BASE;
if (!IO_API_BASE) {
  console.warn('[IO Proxy] IO_API_BASE not set; requests will fail.');
}

function buildTargetUrl(path, query) {
  const base = IO_API_BASE?.replace(/\/$/, '') || '';
  const p = `${path}`.replace(/^\//, '');
  const url = `${base}/api/common/${p}`;
  const qs = new URLSearchParams(query || {}).toString();
  return qs ? `${url}?${qs}` : url;
}

function pickHeaders(req) {
  const headers = {};
  const keys = ['content-type', 'accept', 'authorization', 'apikey', 'x-api-key'];
  for (const k of keys) {
    const v = req.headers[k];
    if (typeof v !== 'undefined') headers[k] = v;
  }
  return headers;
}

async function forward(req, res, path) {
  if (!IO_API_BASE) return res.status(500).json({ error: 'IO_API_BASE not configured' });

  const target = buildTargetUrl(path, req.query);
  const headers = pickHeaders(req);

  console.log(`[IO Proxy] ${req.method} ${req.originalUrl} -> ${target} auth=${req.headers.authorization ? 'yes' : 'no'} apiKeyHeader=${(req.headers.apikey || req.headers['x-api-key']) ? 'yes' : 'no'}`);

  // Ensure apiKey bearer token if missing
  if (!headers['apikey'] && !headers['x-api-key']) {
    try {
      const token = await ensureIoToken();
      headers['apikey'] = `Bearer ${token}`;
    } catch (err) {
      console.error('[IO Proxy] failed to ensure token:', err);
      return res.status(500).json({ error: 'Failed to acquire token', details: err.message });
    }
  }

  try {
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
    });

    // If unauthorized, invalidate cached token and surface error
    if (resp.status === 401) {
      invalidateIoToken();
    }

    const ct = resp.headers.get('content-type') || '';
    console.log(`[IO Proxy] ${req.method} ${req.originalUrl} <- ${resp.status} content-type=${ct}`);
    res.status(resp.status);
    if (ct.includes('application/json')) {
      const data = await resp.json();
      return res.json(data);
    } else {
      const text = await resp.text();
      return res.send(text);
    }
  } catch (err) {
    console.error('[IO Proxy] forward error:', err);
    return res.status(502).json({ error: 'Bad gateway', details: err.message });
  }
}

// ExecStoredProcedure
router.post('/ExecStoredProcedure', async (req, res) => {
  await forward(req, res, 'ExecStoredProcedure');
});

// Catch-all for other /api/common/* paths
router.all('*', async (req, res) => {
  const path = req.path.replace(/^\//, '');
  await forward(req, res, path);
});

module.exports = router;
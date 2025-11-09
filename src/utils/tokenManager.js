const AISCRIBE_API_BASE = process.env.AISCRIBE_API_BASE;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const LOGIN_USERNAME = process.env.LOGIN_USERNAME;
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;

let ioToken = null;
let authToken = null;

// Optionally set TTLs if you know token validity. For now rely on 401 to refresh.
let ioTokenFetchedAt = 0;
let authTokenFetchedAt = 0;

// module scope (near top of file)
const axios = require('axios');
const https = require('https');

function ensureConfig() {
  if (!AISCRIBE_API_BASE) throw new Error('AISCRIBE_API_BASE not configured');
}

// Dev-only: disable TLS verification when ALLOW_INSECURE_TLS=true
if (process.env.ALLOW_INSECURE_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Build an https agent that skips cert verification (dev only)
function buildHttpsAgent() {
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';
  return allowInsecure ? new https.Agent({ rejectUnauthorized: false }) : undefined;
}

function normalizeToken(data) {
  try {
    if (data == null) return '';
    if (typeof data === 'string') return data.trim();

    if (typeof data === 'object') {
      // Envelope with IsToken + Token (current upstream format)
      if (data.IsToken === true && typeof data.Token === 'string') return data.Token;

      // Common fields
      if (typeof data.Token === 'string') return data.Token;
      if (typeof data.token === 'string') return data.token;
      if (typeof data.access_token === 'string') return data.access_token;

      // Nested shapes often returned by HTTP clients
      if (data.data && typeof data.data === 'object') {
        const inner = data.data;
        if (typeof inner.Token === 'string') return inner.Token;
        if (typeof inner.token === 'string') return inner.token;
        if (typeof inner.access_token === 'string') return inner.access_token;
      }
      if (data.result && typeof data.result === 'object') {
        const inner = data.result;
        if (typeof inner.Token === 'string') return inner.Token;
        if (typeof inner.token === 'string') return inner.token;
        if (typeof inner.access_token === 'string') return inner.access_token;
      }

      // Array of tokens
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (typeof first === 'string') return first.trim();
        if (first && typeof first.Token === 'string') return first.Token;
        if (first && typeof first.token === 'string') return first.token;
        if (first && typeof first.access_token === 'string') return first.access_token;
      }
    }
    return '';
  } catch {
    return '';
  }
}

async function fetchIoToken() {
  ensureConfig();
  const url = `${AISCRIBE_API_BASE.replace(/\/$/, '')}/api/Customer/GetTokenAsyncNew?accountId=${encodeURIComponent(ACCOUNT_ID || '')}`;
  const httpsAgent = buildHttpsAgent();
if (process.env.ALLOW_INSECURE_TLS === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

  const headers = { accept: '*/*' }; // no bearer per your request
  const resp = await axios.get(url, {
    headers,
    timeout: 10000,
    httpsAgent,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    throw new Error(`GetTokenAsyncNew failed: ${resp.status} ${body}`);
  }

  const tokenStr = normalizeToken(resp.data);
  if (!tokenStr) throw new Error('Empty token from GetTokenAsyncNew');

  ioToken = String(tokenStr);
  ioTokenFetchedAt = Date.now();
  return ioToken;
}

async function fetchAuthToken() {
  ensureConfig();
  if (!LOGIN_USERNAME || !LOGIN_PASSWORD) throw new Error('LOGIN_USERNAME/LOGIN_PASSWORD not configured');

  const url = `${AISCRIBE_API_BASE.replace(/\/$/, '')}/api/Auth/login`;
  const httpsAgent = buildHttpsAgent();

  const resp = await axios.post(url, { username: LOGIN_USERNAME, password: LOGIN_PASSWORD }, {
    headers: { 'content-type': 'application/json', accept: '*/*' },
    timeout: 10000,
    httpsAgent,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    throw new Error(`Login failed: ${resp.status} ${body}`);
  }

  const tokenStr = normalizeToken(resp.data);
  if (!tokenStr) throw new Error('Empty token from login');

  authToken = String(tokenStr);
  authTokenFetchedAt = Date.now();
  return authToken;
}

async function ensureIoToken() {
  if (ioToken) return ioToken;
  return await fetchIoToken();
}

async function ensureAuthToken() {
  if (authToken) return authToken;
  return await fetchAuthToken();
}

function invalidateIoToken() {
  ioToken = null;
}
function invalidateAuthToken() {
  authToken = null;
}

function getTokenStatus() {
  return {
    ioTokenPresent: Boolean(ioToken),
    ioTokenFetchedAt,
    authTokenPresent: Boolean(authToken),
    authTokenFetchedAt,
  };
}

// tokenManager.js (functions)
function getSelfBaseUrl() {
  // Prefer explicit env; fallback to localhost dev
  const base = process.env.SELF_BASE_URL || 'http://localhost:5000';
  return String(base).replace(/\/$/, '');
}

async function fetchIoTokenForAccount(accountId) {
  ensureConfig();
  const id = String(accountId || '').trim();
  if (!id) throw new Error('accountId is required');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const base = getSelfBaseUrl();
  const url = `${base}/api/Customer/GetTokenAsyncNew?accountId=${encodeURIComponent(id)}`;

  const isHttps = /^https:/i.test(base);
  const httpsAgent =
    isHttps && process.env.ALLOW_INSECURE_TLS === 'true'
      ? new (require('https').Agent)({ rejectUnauthorized: false })
      : undefined;

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await require('axios').get(url, {
        headers: { accept: '*/*' },
        timeout: 30000,
        httpsAgent,
        validateStatus: () => true,
      });
      if (resp.status >= 200 && resp.status < 300) {
        const tokenStr = normalizeToken(resp.data);
        if (!tokenStr) throw new Error('Empty token from GetTokenAsyncNew');
        return String(tokenStr);
      }
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      throw new Error(`GetTokenAsyncNew failed: ${resp.status} ${body}`);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s
    }
  }

  // Fallback to direct AISCRIBE API if configured
  const aisBase = (process.env.AISCRIBE_API_BASE || '').replace(/\/$/, '');
  if (aisBase) {
    const urlAis = `${aisBase}/api/Customer/GetTokenAsyncNew?accountId=${encodeURIComponent(id)}`;
    const httpsAgentAis =
      /^https:/i.test(aisBase) && process.env.ALLOW_INSECURE_TLS === 'true'
        ? new (require('https').Agent)({ rejectUnauthorized: false })
        : undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await require('axios').get(urlAis, {
          headers: { accept: '*/*' },
          timeout: 30000,
          httpsAgent: httpsAgentAis,
          validateStatus: () => true,
        });
        if (resp.status >= 200 && resp.status < 300) {
          const tokenStr = normalizeToken(resp.data);
          if (!tokenStr) throw new Error('Empty token from GetTokenAsyncNew');
          return String(tokenStr);
        }
        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        throw new Error(`GetTokenAsyncNew failed: ${resp.status} ${body}`);
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }

  throw lastErr || new Error('Failed to fetch IO token');
  console.log("IO Token",tokenStr)

  return String(tokenStr);
}

module.exports = {
  ensureIoToken,
  ensureAuthToken,
  fetchIoToken,
  fetchAuthToken,
  invalidateIoToken,
  invalidateAuthToken,
  getTokenStatus,
  fetchIoTokenForAccount,
  normalizeToken,
};
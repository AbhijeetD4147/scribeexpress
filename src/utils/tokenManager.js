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
  if (typeof data === 'string') return data;
  return data?.Token || data?.token || data?.access_token || '';
}

async function fetchIoToken() {
  ensureConfig();
  const url = `${AISCRIBE_API_BASE.replace(/\/$/, '')}/api/Customer/GetTokenAsyncNew?accountId=${encodeURIComponent(ACCOUNT_ID || '')}`;
  const httpsAgent = buildHttpsAgent();

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

async function fetchIoTokenForAccount(accountId) {
  ensureConfig();
  const id = String(accountId || '').trim();
  if (!id) throw new Error('accountId is required');

  const url = `${AISCRIBE_API_BASE.replace(/\/$/, '')}/api/Customer/GetTokenAsyncNew?accountId=${encodeURIComponent(String(accountId || '').trim())}`;
  const httpsAgent = buildHttpsAgent();

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
};
// top-level module (Express router)
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/pool');

// Validates the SSO token using the MSSQL stored procedure and returns the first row
async function cbValidateSSOToken(token) {
  const pool = await getPool();
  const tok = String(token);

  // Try primary SP first
  try {
    const request = pool.request();
    request.input('P_TOKEN', sql.VarChar(4000), tok);
    const result = await request.execute('CB_VALIDATE_CB_SSO_REQUESTS');
    return (result && Array.isArray(result.recordset) && result.recordset[0]) ? result.recordset[0] : null;
  } catch (err) {
    console.warn('[SSO] primary SP failed, trying alternates:', err.message);

    // Try alternate SP name/signature: CB_ValidateSSOToken(Token)
    try {
      const request2 = pool.request();
      request2.input('Token', sql.VarChar(4000), tok);
      const res2 = await request2.execute('CB_ValidateSSOToken');
      return (res2 && Array.isArray(res2.recordset) && res2.recordset[0]) ? res2.recordset[0] : null;
    } catch {
      // Try minimal alternate: ValidateSSOToken(Token)
      try {
        const request3 = pool.request();
        request3.input('Token', sql.VarChar(4000), tok);
        const res3 = await request3.execute('ValidateSSOToken');
        return (res3 && Array.isArray(res3.recordset) && res3.recordset[0]) ? res3.recordset[0] : null;
      } catch (finalErr) {
        console.error('[SSO] all SP attempts failed:', finalErr);
        return null;
      }
    }
  }
}

// Validate SSO token against DB and return a boolean (matches C# Task<bool>)
// Normalize common result shapes to a boolean
function mapResultToBool(result) {
  const row = (result && Array.isArray(result.recordset) && result.recordset[0]) ? result.recordset[0] : null;
  if (row) {
    const candidates = [
      row.useraccessallowed,
      row.UserAccessAllowed,
      row.allowed,
      row.Allowed,
      row.IsValid,
      row.isValid,
      row.Valid,
      row.valid,
      row.SUCCESS,
      row.success
    ];
    for (const val of candidates) {
      if (typeof val === 'boolean') return val;
      if (val === 1 || val === '1') return true;
      if (String(val).toLowerCase() === 'true') return true;
    }
    // If the SP returns a row only on valid token, treat presence as true
    return true;
  }
  if (typeof result?.returnValue === 'number') {
    return result.returnValue === 1;
  }
  return false;
}

// Robust token validator: attempts multiple SP names; returns boolean
async function validateSSOToken(token) {
  const tok = String(token || '');
  if (!tok.trim()) return false;

  try {
    const pool = await getPool();

    // Attempt: ValidateSSOToken(Token)
    try {
      const req1 = pool.request();
      req1.input('@P_Token', sql.VarChar(4000), tok);
      const res1 = await req1.execute('ValidateSSOToken');
      return mapResultToBool(res1);
    } catch (e1) {
      console.warn('[ValidateSSOToken] ValidateSSOToken failed:', e1.message);
    }

    // Attempt: CB_ValidateSSOToken(Token)
    try {
      const req2 = pool.request();
      req2.input('Token', sql.VarChar(4000), tok);
      const res2 = await req2.execute('CB_ValidateSSOToken');
      return mapResultToBool(res2);
    } catch (e2) {
      console.warn('[ValidateSSOToken] CB_ValidateSSOToken failed:', e2.message);
    }

    // Attempt: CB_VALIDATE_CB_SSO_REQUESTS(P_TOKEN) — row presence implies valid
    try {
      const req3 = pool.request();
      req3.input('P_TOKEN', sql.VarChar(4000), tok);
      const res3 = await req3.execute('CB_VALIDATE_CB_SSO_REQUESTS');
      const row = (res3 && Array.isArray(res3.recordset) && res3.recordset[0]) ? res3.recordset[0] : null;
      return !!row;
    } catch (e3) {
      console.warn('[ValidateSSOToken] CB_VALIDATE_CB_SSO_REQUESTS failed:', e3.message);
    }

    return false;
  } catch (err) {
    console.error('[ValidateSSOToken] pool or exec error:', err);
    return false;
  }
}

// GET /api/sso/ValidateSSOToken?Token=...
router.get('/ValidateSSOToken', async (req, res) => {
  try {
    const token = String(req.query.Token || req.query.token || '');
    const allowed = await validateSSOToken(token);
    // Always return bare boolean; no 400/500
    return res.json(Boolean(allowed));
  } catch (err) {
    console.error('[ValidateSSOToken] route error:', err);
    // On any error, mirror C# style: return false
    return res.json(false);
  }
});

// GET /api/sso/CB_SSO_AI_Scribe?accountId=...&botShortGUID=...&token=...&botAdminBaseURL=...
router.get('/CB_SSO_AI_Scribe', async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const botShortGUID = String(req.query.botShortGUID || '');
  const token = String(req.query.token || '');
  const botAdminBaseURL = String(req.query.botAdminBaseURL || '');

  // Ensure one trailing slash on base
  const base = (botAdminBaseURL || '').replace(/\/?$/, '/');
  const defaultRedirect = `${base}e1/${encodeURIComponent(accountId)}/${encodeURIComponent(botShortGUID)}/`;

  try {
    if (!token.trim()) {
      console.warn('[CB_SSO_AI_Scribe] missing token; redirecting default');
      return res.redirect(defaultRedirect);
    }

    console.log(`[CB_SSO_AI_Scribe] validating token=${token}`);
    const sso = await cbValidateSSOToken(token);
    if (!sso) {
      console.warn('[CB_SSO_AI_Scribe] token invalid or SP returned no rows; redirecting default');
      return res.redirect(defaultRedirect);
    }

    // Build redirect URL from DB row (uppercase keys, with ENVIRONMENT/ENVIROMENT fallback)
    const env = String(sso.ENVIRONMENT || sso.ENVIROMENT || '');
    const adminBase = String(sso.BOT_ADMIN_BASE_URL || base).replace(/\/$/, '');
    const redirectUrl =
      `${adminBase}/` +
      `${encodeURIComponent(env)}/` +
      `${encodeURIComponent(String(sso.ACCOUNT_ID || accountId))}/` +
      `${encodeURIComponent(String(sso.BOT_SHORT_GUID || botShortGUID))}` +
      `?UserName=${encodeURIComponent(String(sso.USERNAME || ''))}` +
      `&FirstName=${encodeURIComponent(String(sso.FIRST_NAME || ''))}` +
      `&LastName=${encodeURIComponent(String(sso.LAST_NAME || ''))}` +
      `&Email=${encodeURIComponent(String(sso.EMAIL || ''))}` +
      `&token=${encodeURIComponent(token)}` +
      `&userId=${encodeURIComponent(String(sso.USER_ID ?? ''))}` +
      `&GlobalUserId=${encodeURIComponent(String(sso.GLOBAL_USER_ID || ''))}`;

    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('[CB_SSO_AI_Scribe] error:', err);
    // Mirror C# behavior: on error, go to default redirect instead of 500 JSON
    return res.redirect(defaultRedirect);
  }
});

module.exports = router;

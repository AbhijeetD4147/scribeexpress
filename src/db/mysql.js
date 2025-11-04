const mysql = require('mysql2/promise');

const RETRY_CNT = parseInt(process.env.DB_RETRY_COUNT || '3', 10);
const RETRY_WAIT_1 = parseInt(process.env.DB_RETRY_WAIT1 || '500', 10);
const RETRY_WAIT_2 = parseInt(process.env.DB_RETRY_WAIT2 || '1000', 10);
const RETRY_WAIT_3 = parseInt(process.env.DB_RETRY_WAIT3 || '2000', 10);

function buildConfigFromEnv() {
  if (process.env.MYSQL_URL) {
    // Expect a DSN like: mysql://user:pass@host:3306/database?ssl=true
    const u = new URL(process.env.MYSQL_URL);
    const sslParam = u.searchParams.get('ssl');
    const allowInsecure = process.env.ALLOW_INSECURE_TLS_MYSQL === 'true';
    const ssl =
      sslParam === 'true' || sslParam === '1'
        ? { minVersion: 'TLSv1.2', rejectUnauthorized: !allowInsecure }
        : undefined;
    return {
      host: u.hostname,
      port: parseInt(u.port || '3306', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      ssl,
      waitForConnections: true,
      connectionLimit: parseInt(process.env.MYSQL_POOL_MAX || '10', 10),
      queueLimit: 0,
    };
  }

  // Fallback: read either MYSQL_* or DB_* env names
  const allowInsecure = process.env.ALLOW_INSECURE_TLS_MYSQL === 'true';
  const useSsl =
    (process.env.MYSQL_SSL || '').toLowerCase() === 'true' ||
    (process.env.DB_ENCRYPT || '').toLowerCase() === 'true';
  const ssl = useSsl
    ? { minVersion: 'TLSv1.2', rejectUnauthorized: !(process.env.DB_TRUST_CERT === 'true' || allowInsecure) }
    : undefined;

  return {
    host: process.env.MYSQL_HOST || process.env.DB_SERVER,
    port: parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '3306', 10),
    user: process.env.MYSQL_USER || process.env.DB_USER,
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQL_DATABASE || process.env.DB_DATABASE,
    ssl,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.MYSQL_POOL_MAX || '10', 10),
    queueLimit: 0,
  };
}

const pool = mysql.createPool(buildConfigFromEnv());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs CB_GET_VENDOR_CREDENTIALS with parameters mirroring your C# method
async function getVendorCredentialsUsingAccountIdIO(accountId) {
  const chooseUrl = String(accountId || '').trim();
  if (!chooseUrl) throw new Error('accountId is required');

  const retryWaits = [RETRY_WAIT_1, RETRY_WAIT_2, RETRY_WAIT_3];

  // Connection open (pool manages connections; we ensure first execution tolerates transient errors)
  let attempt = 0;
  while (attempt < RETRY_CNT) {
    try {
      // Stored procedure signature: (P_CREDENTIALS_ID, P_VENDOR_ID, P_ACCOUNT_ID, P_VENDOR_NAME)
      const [results] = await pool.query('CALL CB_GET_VENDOR_CREDENTIALS(?, ?, ?, ?)', [
        null,
        null,
        chooseUrl,
        'MaximEyes AI Scribe',
      ]);

      // mysql2 returns: [ [rows], [fields], ... ] for CALL; rows are typically in results[0]
      const rows = Array.isArray(results) ? results[0] || results : results;
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
      return row || null;
    } catch (err) {
      const msg = (err?.message || '').toLowerCase();
      const isTransient =
        msg.includes('severe error occurred on the current command') ||
        msg.includes('one or more error') ||
        msg.includes('transport level error') ||
        msg.includes('timeout expired') ||
        msg.includes('timeout') ||
        msg.includes('connection') ||
        msg.includes('deadlock') ||
        msg.includes('lock wait timeout');

      if (!isTransient || attempt >= RETRY_CNT - 1) {
        throw err;
      }
      const wait = retryWaits[Math.min(attempt, retryWaits.length - 1)];
      await sleep(wait);
      attempt += 1;
    }
  }

  return null;
}

module.exports = {
  getVendorCredentialsUsingAccountIdIO,
};
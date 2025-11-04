const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  connectionTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '30000', 10),
  requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT || '30000', 10),
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

let poolPromise;

/**
 * Lazily create and reuse a single connection pool.
 * @returns {Promise<sql.ConnectionPool>}
 */
function getPool() {
  if (!poolPromise) {
    console.log(`[MSSQL] Connecting to ${config.server}:${config.port} db=${config.database} encrypt=${config.options.encrypt} trustCert=${config.options.trustServerCertificate}`);
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then(pool => {
        console.log('[MSSQL] Connected');
        return pool;
      })
      .catch(err => {
        const host = String(config.server || '');
        const hint = host.includes('.mysql.database.azure.com')
          ? 'Configured DB host looks like Azure MySQL; MSSQL driver requires Azure SQL (*.database.windows.net).'
          : '';
        console.error('[MSSQL] Connection error:', err.message, hint);
        throw err;
      });
  }
  return poolPromise;
}

/**
 * Run a simple query using the pooled connection.
 * @param {string} query
 * @returns {Promise<sql.IResult<any>>}
 */
async function runQuery(query) {
  const pool = await getPool();
  return pool.request().query(query);
}

module.exports = {
  sql,
  getPool,
  runQuery
};
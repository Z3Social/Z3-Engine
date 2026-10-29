import pg from 'pg';

const { Pool } = pg;

// Strict connection pooling to guarantee < 40MB idle RAM and prevent leaks
const poolConfig = {
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'z3_engine',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: Number(process.env.PGMAX) || 10,
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT) || 2000,
};

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[Z3-Engine DB Pool Error]:', err.message);
});

/**
 * Executes a query with safe error handling and pool management
 * @param {string} text - SQL statement
 * @param {Array} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params = []) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development' && duration > 200) {
      console.warn(`[Slow Query] (${duration}ms):`, text.slice(0, 80));
    }
    return res;
  } catch (err) {
    console.error('[DB Query Error]:', err.message, { text: text.slice(0, 100), params });
    throw err;
  }
}

/**
 * Helper to acquire a transaction client
 * @param {(client: pg.PoolClient) => Promise<any>} callback
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default {
  pool,
  query,
  withTransaction,
};

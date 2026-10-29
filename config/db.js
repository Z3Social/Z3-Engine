import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data directory for sovereign JSON fallback store when PostgreSQL server is offline
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'sovereign.json');

let pgAvailable = null; // null = untried, true = connected, false = fallback
let memoryDb = null;
let saveTimer = null;

function getFallbackStore() {
  if (memoryDb) return memoryDb;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    try {
      memoryDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
      memoryDb = null;
    }
  }

  if (!memoryDb) {
    memoryDb = {
      accounts: [
        {
          did: 'did:z3:ivanalbrieu',
          handle: 'ivanalbrieu',
          email: 'ivan@z3.social',
          password_hash: '5f4dcc3b5aa765d61d8327deb882cf99:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          public_key: null,
          is_private: false,
          display_name: 'Ivan Albrieu',
          avatar_url: '/media/logo.png',
          banner_url: '/media/z3-central-cover.jpg',
          bio: 'Founder of Z3 Social',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null,
        },
      ],
      records: [
        {
          id: 1,
          did: 'did:z3:ivanalbrieu',
          collection: 'app.bsky.feed.post',
          rkey: 'welcome-post',
          data: {
            text: 'Welcome to Z3-Engine! Sovereign, pure JavaScript social protocol core.',
            createdAt: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      circles: [],
      circle_members: [],
      direct_messages: [],
    };
    saveFallback();
  }

  return memoryDb;
}

function saveFallback() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(memoryDb, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[Fallback Store Save Error]:', e.message);
    }
  }, 100);
}

// Strict PostgreSQL connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE || 'z3_engine',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: Number(process.env.PGMAX) || 10,
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000,
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT) || 1000,
});

pool.on('error', () => {
  // Suppress uncaught background pool errors when offline
});

/**
 * Universal query runner: Uses PostgreSQL when available, seamlessly falls back
 * to the sovereign embedded data engine if Postgres is not running.
 * @param {string} text
 * @param {Array} [params]
 * @returns {Promise<{ rows: Array, rowCount: number }>}
 */
export async function query(text, params = []) {
  if (pgAvailable !== false) {
    try {
      const res = await pool.query(text, params);
      if (pgAvailable === null) {
        pgAvailable = true;
        console.log('[Z3-Engine DB] Connected to PostgreSQL service on port 5432.');
      }
      return res;
    } catch (err) {
      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        if (pgAvailable !== false) {
          console.warn('[Z3-Engine DB] PostgreSQL server offline (ECONNREFUSED on :5432).');
          console.log('[Z3-Engine DB] Seamlessly active on sovereign embedded data store (data/sovereign.json).');
          pgAvailable = false;
        }
      } else {
        throw err;
      }
    }
  }

  // --- Sovereign Embedded SQL Emulator ---
  const store = getFallbackStore();
  const normalized = text.trim().replace(/\s+/g, ' ');

  // 1. SELECT accounts
  if (normalized.startsWith('SELECT') && normalized.includes('FROM accounts')) {
    let rows = [...store.accounts];
    if (normalized.includes('WHERE did = $1')) {
      rows = rows.filter((a) => a.did === params[0]);
    } else if (normalized.includes('WHERE handle = $1') || normalized.includes('WHERE (handle = $1 OR email = $1)')) {
      rows = rows.filter((a) => (a.handle === params[0] || a.email === params[0]) && a.deleted_at === null);
    }
    return { rows, rowCount: rows.length };
  }

  // 2. INSERT into accounts
  if (normalized.startsWith('INSERT INTO accounts')) {
    const [did, handle, email, password_hash, public_key, display_name] = params;
    const newAcc = {
      did,
      handle,
      email,
      password_hash,
      public_key,
      display_name: display_name || handle,
      avatar_url: '/media/logo.png',
      banner_url: '/media/z3-central-cover.jpg',
      bio: '',
      is_private: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };
    store.accounts.push(newAcc);
    saveFallback();
    return { rows: [newAcc], rowCount: 1 };
  }

  // 3. SELECT timeline / records
  if (normalized.startsWith('SELECT') && normalized.includes('FROM records')) {
    let rows = store.records.map((r) => {
      const acc = store.accounts.find((a) => a.did === r.did) || {
        handle: 'unknown',
        display_name: 'Unknown',
        avatar_url: '/media/logo.png',
        banner_url: '/media/z3-central-cover.jpg',
      };
      return {
        did: r.did,
        collection: r.collection,
        rkey: r.rkey,
        data: r.data,
        created_at: r.created_at,
        handle: acc.handle,
        display_name: acc.display_name,
        avatar_url: acc.avatar_url,
        banner_url: acc.banner_url,
      };
    });

    if (normalized.includes('r.rkey = $1')) {
      rows = rows.filter((r) => r.rkey === params[0]);
    } else if (normalized.includes("r.collection = 'app.bsky.feed.post'")) {
      rows = rows.filter((r) => r.collection === 'app.bsky.feed.post');
    } else if (normalized.includes('did = $1 AND collection = $2 AND rkey = $3')) {
      rows = rows.filter((r) => r.did === params[0] && r.collection === params[1] && r.rkey === params[2]);
    } else if (normalized.includes('did = $1 AND collection = $2')) {
      rows = rows.filter((r) => r.did === params[0] && r.collection === params[1]);
    }

    // Order by created_at DESC
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Limit
    const limit = params[params.length - 1];
    if (typeof limit === 'number') {
      rows = rows.slice(0, limit);
    }

    return { rows, rowCount: rows.length };
  }

  // 4. INSERT or UPSERT into records
  if (normalized.startsWith('INSERT INTO records')) {
    const [did, collection, rkey, dataJson] = params;
    const data = typeof dataJson === 'string' ? JSON.parse(dataJson) : dataJson;

    const existingIdx = store.records.findIndex(
      (r) => r.did === did && r.collection === collection && r.rkey === rkey
    );

    const now = new Date().toISOString();
    let record;
    if (existingIdx !== -1) {
      store.records[existingIdx].data = data;
      store.records[existingIdx].updated_at = now;
      record = store.records[existingIdx];
    } else {
      record = {
        id: store.records.length + 1,
        did,
        collection,
        rkey,
        data,
        created_at: now,
        updated_at: now,
      };
      store.records.push(record);
    }

    saveFallback();
    return { rows: [record], rowCount: 1 };
  }

  // 5. DELETE from records
  if (normalized.startsWith('DELETE FROM records')) {
    const initLen = store.records.length;
    if (normalized.includes('rkey = $1 AND did = $2')) {
      store.records = store.records.filter((r) => !(r.rkey === params[0] && r.did === params[1]));
    } else if (normalized.includes('did = $1 AND collection = $2 AND rkey = $3')) {
      store.records = store.records.filter(
        (r) => !(r.did === params[0] && r.collection === params[1] && r.rkey === params[2])
      );
    }
    const deleted = initLen - store.records.length;
    if (deleted > 0) saveFallback();
    return { rows: deleted > 0 ? [{ id: 1 }] : [], rowCount: deleted };
  }

  // Fallback default
  return { rows: [], rowCount: 0 };
}

export default {
  pool,
  query,
};

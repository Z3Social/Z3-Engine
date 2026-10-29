import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
          password_hash: 'd2ea49e202cc4beafaf6fb9db87b7c11:9ab79c23d41a5d611d87beb329f43d3b9929cc09fb0d3080da638d2b5b0dd560b0d99c366e86ae890bd6050f1fe6ac51050d5dc6e207010ed779543186bf39f0',
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
    } else if (normalized.includes('did = $1 OR handle = $1') || normalized.includes('did = $1 OR handle = $1')) {
      const p = String(params[0] || '').toLowerCase();
      rows = rows.filter((a) => (a.did === params[0] || a.handle === params[0] || (a.handle && a.handle.toLowerCase() === p)) && a.deleted_at === null);
    } else if (normalized.includes('lower(handle) = lower($1)') || normalized.includes('LOWER(handle) = LOWER($1)')) {
      const p = String(params[0] || '').toLowerCase();
      rows = rows.filter((a) => ((a.handle && a.handle.toLowerCase() === p) || (a.email && a.email.toLowerCase() === p)) && a.deleted_at === null);
    } else if (normalized.includes('WHERE handle = $1') || normalized.includes('WHERE (handle = $1 OR email = $1)')) {
      rows = rows.filter((a) => (a.handle === params[0] || a.email === params[0]) && a.deleted_at === null);
    }
    return { rows, rowCount: rows.length };
  }

  // 1b. UPDATE accounts
  if (normalized.startsWith('UPDATE accounts SET')) {
    // e.g. UPDATE accounts SET display_name = $1, bio = $2, avatar_url = $3, banner_url = $4, updated_at = NOW() WHERE did = $5 RETURNING *
    const targetDid = params[params.length - 1];
    const acc = store.accounts.find((a) => a.did === targetDid);
    if (acc) {
      // Parse assignments
      const setPart = normalized.slice('UPDATE accounts SET'.length, normalized.indexOf('WHERE')).trim();
      const assignments = setPart.split(',').map((s) => s.trim());
      assignments.forEach((assign) => {
        const [col, paramPlaceholder] = assign.split('=').map((s) => s.trim());
        const match = paramPlaceholder.match(/\$(\d+)/);
        if (match) {
          const pIdx = parseInt(match[1], 10) - 1;
          acc[col] = params[pIdx];
        } else if (paramPlaceholder.toUpperCase() === 'NOW()') {
          acc[col] = new Date().toISOString();
        }
      });
      acc.updated_at = new Date().toISOString();
      saveFallback();
      return { rows: [acc], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
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

  // 2. SELECT circles / groups
  if (normalized.startsWith('SELECT') && (normalized.includes('FROM circles') || normalized.includes('FROM groups'))) {
    const list = store.groups || store.circles || [];
    if (normalized.includes('WHERE id = $1')) {
      const g = list.find((x) => x.id === params[0] || x.slug === params[0]);
      return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
    }
    return { rows: list, rowCount: list.length };
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
    } else if (normalized.includes("r.data->>'group' = $1") || normalized.includes("r.data->>'groupId' = $1")) {
      rows = rows.filter((r) => r.data?.group === params[0] || r.data?.groupId === params[0]);
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

  // 4b. UPDATE records
  if (normalized.startsWith('UPDATE records SET')) {
    // e.g. UPDATE records SET data = $1, updated_at = NOW() WHERE rkey = $2 RETURNING *
    const rkey = params[params.length - 1];
    const rec = store.records.find((r) => r.rkey === rkey);
    if (rec) {
      const dataJson = params[0];
      rec.data = typeof dataJson === 'string' ? JSON.parse(dataJson) : dataJson;
      rec.updated_at = new Date().toISOString();
      saveFallback();
      return { rows: [rec], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
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

  // 6. direct_messages (Tracker #15: Sovereign Direct Messages)
  if (normalized.startsWith('SELECT') && normalized.includes('FROM direct_messages')) {
    store.direct_messages = store.direct_messages || [];
    let rows = [...store.direct_messages];
    if (normalized.includes('(sender_did = $1 AND recipient_did = $2) OR (sender_did = $2 AND recipient_did = $1)')) {
      const u1 = params[0];
      const u2 = params[1];
      rows = rows.filter(
        (m) => (m.sender_did === u1 && m.recipient_did === u2) || (m.sender_did === u2 && m.recipient_did === u1)
      );
    } else if (normalized.includes('sender_did = $1 OR recipient_did = $1')) {
      const u1 = params[0];
      rows = rows.filter((m) => m.sender_did === u1 || m.recipient_did === u1);
    } else if (normalized.includes('id = $1')) {
      rows = rows.filter((m) => String(m.id) === String(params[0]));
    }
    rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return { rows, rowCount: rows.length };
  }

  if (normalized.startsWith('INSERT INTO direct_messages')) {
    store.direct_messages = store.direct_messages || [];
    const [sender_did, recipient_did, ciphertext, media_url] = params;
    const msg = {
      id: crypto.randomUUID ? crypto.randomUUID() : `dm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_did,
      recipient_did,
      ciphertext,
      media_url: media_url || null,
      reactions: {},
      read_at: null,
      created_at: new Date().toISOString(),
    };
    store.direct_messages.push(msg);
    saveFallback();
    return { rows: [msg], rowCount: 1 };
  }

  if (normalized.startsWith('UPDATE direct_messages SET')) {
    store.direct_messages = store.direct_messages || [];
    if (normalized.includes('read_at = NOW()') || normalized.includes('read_at = $1')) {
      // e.g. UPDATE direct_messages SET read_at = NOW() WHERE sender_did = $1 AND recipient_did = $2 AND read_at IS NULL
      const sender = params[0];
      const recipient = params[1];
      let updatedCount = 0;
      store.direct_messages.forEach((m) => {
        if (m.sender_did === sender && m.recipient_did === recipient && !m.read_at) {
          m.read_at = new Date().toISOString();
          updatedCount++;
        }
      });
      if (updatedCount > 0) saveFallback();
      return { rows: [], rowCount: updatedCount };
    }
    if (normalized.includes('reactions = $1 WHERE id = $2')) {
      const targetMsg = store.direct_messages.find((m) => String(m.id) === String(params[1]));
      if (targetMsg) {
        targetMsg.reactions = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
        saveFallback();
        return { rows: [targetMsg], rowCount: 1 };
      }
    }
  }

  if (normalized.startsWith('DELETE FROM direct_messages')) {
    store.direct_messages = store.direct_messages || [];
    const initLen = store.direct_messages.length;
    if (normalized.includes('id = $1 AND sender_did = $2')) {
      store.direct_messages = store.direct_messages.filter(
        (m) => !(String(m.id) === String(params[0]) && m.sender_did === params[1])
      );
    }
    const deleted = initLen - store.direct_messages.length;
    if (deleted > 0) saveFallback();
    return { rows: deleted > 0 ? [{ id: params[0] }] : [], rowCount: deleted };
  }

  // Fallback default
  return { rows: [], rowCount: 0 };
}

export default {
  pool,
  query,
};

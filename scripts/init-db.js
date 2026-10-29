import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../config/db.js';
import { hashPassword, generateKeyPair } from '../lib/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function init() {
  console.log('[Z3-Engine] Initializing PostgreSQL schema...');
  const schemaPath = path.resolve(__dirname, '../schemas/init.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  try {
    await query(sql);
    console.log('[Z3-Engine] Database tables and indexes created successfully.');

    // Seed default admin account if none exists
    const checkAcc = await query('SELECT did FROM accounts WHERE handle = $1', ['ivanalbrieu']);
    if (!checkAcc.rows.length) {
      console.log('[Z3-Engine] Seeding primary sovereign account @ivanalbrieu...');
      const did = 'did:z3:ivanalbrieu';
      const passwordHash = await hashPassword('password123');
      const { publicKey } = generateKeyPair();

      await query(
        `INSERT INTO accounts (did, handle, email, password_hash, public_key, display_name, bio, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [did, 'ivanalbrieu', 'ivan@z3.social', passwordHash, publicKey, 'Ivan Albrieu', 'Founder of Z3 Social']
      );

      // Seed initial post
      await query(
        `INSERT INTO records (did, collection, rkey, data)
         VALUES ($1, 'app.bsky.feed.post', 'seed-post-01', $2)`,
        [did, JSON.stringify({ text: 'Welcome to Z3-Engine! Sovereign, pure JavaScript social protocol core.', createdAt: new Date().toISOString() })]
      );
      console.log('[Z3-Engine] Default account @ivanalbrieu seeded.');
    }

    console.log('[Z3-Engine] Initialization complete.');
    process.exit(0);
  } catch (err) {
    console.error('[Z3-Engine Init Failed]:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();

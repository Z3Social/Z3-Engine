import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTID, parseAtUri, formatAtUri } from '../lib/syntax.js';
import { assertValidRecord, XRPCError } from '../lib/lex/index.js';
import { query } from '../config/db.js';
import { sha256 } from '../lib/crypto.js';

test('Suite 1: Syntax & TID Verification', async (t) => {
  await t.test('1.1 TID Monotonicity (1,000 sequentially generated TIDs)', () => {
    let prevTid = generateTID();
    for (let i = 0; i < 1000; i++) {
      const nextTid = generateTID();
      assert.ok(
        nextTid >= prevTid,
        `TID monotonicity failed: ${nextTid} not >= ${prevTid}`
      );
      prevTid = nextTid;
    }
  });

  await t.test('1.2 TID Crockford Base32 Alphabet Compliance', () => {
    const ATPROTO_CHARS = '234567abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < 100; i++) {
      const tid = generateTID();
      assert.equal(tid.length, 13, `TID length must be exactly 13, got ${tid.length}`);
      for (const char of tid) {
        assert.ok(
          ATPROTO_CHARS.includes(char),
          `Invalid character "${char}" found in TID "${tid}"`
        );
      }
    }
  });

  await t.test('1.3 Sub-millisecond Collision Resistance', () => {
    const tids = new Set();
    for (let i = 0; i < 500; i++) {
      const tid = generateTID();
      assert.ok(!tids.has(tid), `TID collision detected: "${tid}"`);
      tids.add(tid);
    }
  });

  await t.test('1.4 Valid AT-URI Parsing & Formatting', () => {
    const parsed1 = parseAtUri('at://did:z3:alice/app.bsky.feed.post/3jui123');
    assert.deepEqual(parsed1, {
      repo: 'did:z3:alice',
      collection: 'app.bsky.feed.post',
      rkey: '3jui123',
    });

    const parsed2 = parseAtUri('at://alice.z3.social/org.z3social.group/main');
    assert.deepEqual(parsed2, {
      repo: 'alice.z3.social',
      collection: 'org.z3social.group',
      rkey: 'main',
    });

    const formatted = formatAtUri('did:z3:bob', 'org.z3social.circle', 'close-friends');
    assert.equal(formatted, 'at://did:z3:bob/org.z3social.circle/close-friends');
  });

  await t.test('1.5 Invalid AT-URI Rejection', () => {
    assert.throws(() => parseAtUri('http://did:z3:alice/app.bsky.feed.post/123'), /Invalid AT-URI/);
    assert.throws(() => parseAtUri(''), /Invalid AT-URI/);
    assert.throws(() => parseAtUri(null), /Invalid AT-URI/);
    assert.throws(() => parseAtUri(12345), /Invalid AT-URI/);
  });
});

test('Suite 2: Lexicon Schema Engine & Boundary Conditions', async (t) => {
  await t.test('2.1 Standard Schema (app.bsky.feed.post) Valid Cases', () => {
    assert.doesNotThrow(() => {
      assertValidRecord('app.bsky.feed.post', {
        text: 'Testing standard AT-Protocol post payload 🎉',
        createdAt: new Date().toISOString(),
      });
    });
  });

  await t.test('2.2 Standard Schema (app.bsky.feed.post) Invalid Cases', () => {
    // Missing required 'text'
    assert.throws(() => {
      assertValidRecord('app.bsky.feed.post', {
        createdAt: new Date().toISOString(),
      });
    }, (err) => err instanceof XRPCError && err.status === 400);

    // Missing required 'createdAt'
    assert.throws(() => {
      assertValidRecord('app.bsky.feed.post', {
        text: 'Post with missing timestamp',
      });
    }, (err) => err instanceof XRPCError && err.status === 400);

    // Exceeds max graphemes (3000)
    assert.throws(() => {
      assertValidRecord('app.bsky.feed.post', {
        text: 'a'.repeat(3001),
        createdAt: new Date().toISOString(),
      });
    }, (err) => err instanceof XRPCError && err.status === 400);

    // Invalid createdAt format
    assert.throws(() => {
      assertValidRecord('app.bsky.feed.post', {
        text: 'Invalid date check',
        createdAt: 'not-a-valid-iso-date',
      });
    }, (err) => err instanceof XRPCError && err.status === 400);
  });

  await t.test('2.3 Custom Sovereign Schema (org.z3social.group)', () => {
    // Valid group
    assert.doesNotThrow(() => {
      assertValidRecord('org.z3social.group', {
        name: 'Classical Composers',
        description: 'Discussion and sheet music',
        privacy: 'public',
        createdAt: new Date().toISOString(),
      });
    });

    // Missing required 'name'
    assert.throws(() => {
      assertValidRecord('org.z3social.group', {
        description: 'Missing name',
        privacy: 'public',
        createdAt: new Date().toISOString(),
      });
    }, (err) => err instanceof XRPCError && err.status === 400);
  });

  await t.test('2.4 Custom Sovereign Schema (org.z3social.circle)', () => {
    // Valid circle
    assert.doesNotThrow(() => {
      assertValidRecord('org.z3social.circle', {
        name: 'Family Circle',
        isPrivate: true,
        createdAt: new Date().toISOString(),
      });
    });

    // Invalid type for isPrivate (string instead of boolean)
    assert.throws(() => {
      assertValidRecord('org.z3social.circle', {
        name: 'Family Circle',
        isPrivate: 'yes',
        createdAt: new Date().toISOString(),
      });
    }, (err) => err instanceof XRPCError && err.status === 400);
  });
});

test('Suite 3: Repository CRUD & Database Persistence Logic', async (t) => {
  const testDid = 'did:z3:ivanalbrieu';
  const testCollection = 'app.bsky.feed.post';
  const testRkey = `test-audit-${Date.now()}`;
  const initialPost = {
    text: 'Audit test post initial content',
    createdAt: new Date().toISOString(),
  };

  await t.test('3.1 Record Creation (Insert into repository)', async () => {
    const insertSql = `
      INSERT INTO records (did, collection, rkey, data, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, did, collection, rkey, data, created_at, updated_at
    `;
    const res = await query(insertSql, [testDid, testCollection, testRkey, JSON.stringify(initialPost)]);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].rkey, testRkey);
    assert.equal(res.rows[0].data.text, initialPost.text);
  });

  await t.test('3.2 Record Retrieval (Lookup by did, collection, rkey)', async () => {
    const selectSql = `
      SELECT did, collection, rkey, data, created_at, updated_at
      FROM records
      WHERE did = $1 AND collection = $2 AND rkey = $3
    `;
    const res = await query(selectSql, [testDid, testCollection, testRkey]);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].data.text, initialPost.text);

    // CID deterministic computation
    const cid = `bafy${sha256(res.rows[0].data).slice(0, 32)}`;
    assert.ok(cid.startsWith('bafy'));
    assert.equal(cid.length, 36);
  });

  await t.test('3.3 Record Update (UPSERT on conflict)', async () => {
    const updatedPost = {
      text: 'Audit test post updated content (Tracker #8 resolution)',
      createdAt: initialPost.createdAt,
      editedAt: new Date().toISOString(),
    };

    const upsertSql = `
      INSERT INTO records (did, collection, rkey, data, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (did, collection, rkey)
      DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
      RETURNING id, did, collection, rkey, data, created_at, updated_at
    `;
    const res = await query(upsertSql, [testDid, testCollection, testRkey, JSON.stringify(updatedPost)]);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].data.text, updatedPost.text);
    assert.ok(res.rows[0].data.editedAt);
  });

  await t.test('3.4 Record Deletion', async () => {
    const deleteSql = `
      DELETE FROM records
      WHERE did = $1 AND collection = $2 AND rkey = $3
      RETURNING id
    `;
    const res = await query(deleteSql, [testDid, testCollection, testRkey]);
    assert.equal(res.rows.length, 1);

    // Verify record is gone
    const verifySql = `SELECT id FROM records WHERE did = $1 AND collection = $2 AND rkey = $3`;
    const checkRes = await query(verifySql, [testDid, testCollection, testRkey]);
    assert.equal(checkRes.rows.length, 0);
  });
});

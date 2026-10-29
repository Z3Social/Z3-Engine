import express from 'express';
import { query } from '../config/db.js';
import { assertValidRecord, XRPCError } from '../lib/lex/index.js';
import { generateTID, formatAtUri } from '../lib/syntax.js';
import { sha256 } from '../lib/crypto.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { canViewAccount, canAccessCircle } from '../middleware/privacy.js';

export const xrpcRouter = express.Router();

// Parse JSON & URL-encoded params for XRPC
xrpcRouter.use(express.json({ limit: '10mb' }));
xrpcRouter.use(express.urlencoded({ extended: true }));
xrpcRouter.use(optionalAuth);

/**
 * Universal XRPC dispatcher: ALL /xrpc/:nsid
 */
xrpcRouter.all('/:nsid', async (req, res) => {
  const { nsid } = req.params;
  const isPost = req.method === 'POST';

  try {
    switch (nsid) {
      // ---------------------------------------------------- com.atproto.repo.putRecord
      case 'com.atproto.repo.putRecord': {
        if (!req.user) throw XRPCError.authRequired();

        const { repo, collection, rkey: requestedRkey, record, validate = true } = req.body;
        if (!collection || !record) {
          throw XRPCError.invalidRequest('Missing required fields: collection or record.');
        }

        // Sovereign rule: User can only write to their own repo
        if (repo && repo !== req.user.did && repo !== req.user.handle) {
          throw XRPCError.forbidden('Cannot write records to a repository you do not own.');
        }

        // Schema validation on the fly via Lexicon engine
        if (validate !== false) {
          assertValidRecord(collection, record);
        }

        // If no rkey supplied, generate sovereign TID
        const rkey = requestedRkey || generateTID();
        const cid = `bafy${sha256(record).slice(0, 32)}`; // Sovereign deterministic CID representation
        const atUri = formatAtUri(req.user.did, collection, rkey);

        // Perform UPSERT on records table (Resolves post edits Tracker #8)
        const sql = `
          INSERT INTO records (did, collection, rkey, data, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (did, collection, rkey)
          DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
          RETURNING id, created_at, updated_at
        `;

        await query(sql, [req.user.did, collection, rkey, JSON.stringify(record)]);

        return res.json({
          uri: atUri,
          cid,
          commit: { cid, rev: rkey },
          validationStatus: 'valid',
        });
      }

      // ---------------------------------------------------- com.atproto.repo.getRecord
      case 'com.atproto.repo.getRecord': {
        const repo = req.query.repo || req.body?.repo;
        const collection = req.query.collection || req.body?.collection;
        const rkey = req.query.rkey || req.body?.rkey;

        if (!repo || !collection || !rkey) {
          throw XRPCError.invalidRequest('Missing repo, collection, or rkey parameter.');
        }

        // Resolve DID if handle provided
        let targetDid = repo;
        if (!targetDid.startsWith('did:')) {
          const acc = await query('SELECT did FROM accounts WHERE handle = $1', [repo]);
          if (!acc.rows.length) throw XRPCError.notFound('Account not found.');
          targetDid = acc.rows[0].did;
        }

        // Privacy check (Tracker #6)
        const allowed = await canViewAccount(req.user?.did || null, targetDid);
        if (!allowed) throw XRPCError.forbidden('This account is private.');

        const recRes = await query(
          'SELECT did, collection, rkey, data, created_at FROM records WHERE did = $1 AND collection = $2 AND rkey = $3',
          [targetDid, collection, rkey]
        );

        if (!recRes.rows.length) throw XRPCError.notFound('Record not found.');

        const rec = recRes.rows[0];

        // Circle check if post has circle assigned (Tracker #10)
        if (rec.data?.circle) {
          const circleAllowed = await canAccessCircle(req.user?.did || null, rec.data.circle);
          if (!circleAllowed) throw XRPCError.forbidden('You do not belong to this circle.');
        }

        return res.json({
          uri: formatAtUri(rec.did, rec.collection, rec.rkey),
          cid: `bafy${sha256(rec.data).slice(0, 32)}`,
          value: rec.data,
        });
      }

      // ---------------------------------------------------- com.atproto.repo.listRecords
      case 'com.atproto.repo.listRecords': {
        const repo = req.query.repo || req.body?.repo;
        const collection = req.query.collection || req.body?.collection;
        const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 100);

        if (!repo || !collection) {
          throw XRPCError.invalidRequest('Missing repo or collection.');
        }

        let targetDid = repo;
        if (!targetDid.startsWith('did:')) {
          const acc = await query('SELECT did FROM accounts WHERE handle = $1', [repo]);
          if (!acc.rows.length) throw XRPCError.notFound('Account not found.');
          targetDid = acc.rows[0].did;
        }

        // Privacy check
        const allowed = await canViewAccount(req.user?.did || null, targetDid);
        if (!allowed) throw XRPCError.forbidden('This account is private.');

        const recsRes = await query(
          `SELECT did, collection, rkey, data, created_at FROM records 
           WHERE did = $1 AND collection = $2 
           ORDER BY created_at DESC LIMIT $3`,
          [targetDid, collection, limit]
        );

        const outRecords = [];
        for (const row of recsRes.rows) {
          if (row.data?.circle) {
            const circleOk = await canAccessCircle(req.user?.did || null, row.data.circle);
            if (!circleOk) continue;
          }
          outRecords.push({
            uri: formatAtUri(row.did, row.collection, row.rkey),
            cid: `bafy${sha256(row.data).slice(0, 32)}`,
            value: row.data,
          });
        }

        return res.json({ records: outRecords });
      }

      // ---------------------------------------------------- com.atproto.repo.deleteRecord
      case 'com.atproto.repo.deleteRecord': {
        if (!req.user) throw XRPCError.authRequired();
        const { repo, collection, rkey } = req.body;

        if (repo && repo !== req.user.did && repo !== req.user.handle) {
          throw XRPCError.forbidden('Cannot delete records from another account.');
        }

        const delRes = await query(
          'DELETE FROM records WHERE did = $1 AND collection = $2 AND rkey = $3 RETURNING id',
          [req.user.did, collection, rkey]
        );

        if (!delRes.rows.length) throw XRPCError.notFound('Record not found.');
        return res.json({ success: true, uri: formatAtUri(req.user.did, collection, rkey) });
      }

      // ---------------------------------------------------- getTimeline (Tracker #23)
      case 'app.bsky.feed.getTimeline':
      case 'org.z3social.feed.getTimeline': {
        if (!req.user) throw XRPCError.authRequired();

        const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);

        // Tracker #23: Timeline only queries followed DIDs and user's own posts
        const timelineSql = `
          WITH followed AS (
            SELECT data->>'subject' AS did FROM records 
            WHERE did = $1 AND collection = 'app.bsky.graph.follow'
            UNION SELECT $1 AS did
          )
          SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
                 a.handle, a.display_name, a.avatar_url
          FROM records r
          JOIN accounts a ON a.did = r.did
          WHERE r.did IN (SELECT did FROM followed)
            AND r.collection = 'app.bsky.feed.post'
            AND a.deleted_at IS NULL
          ORDER BY r.created_at DESC
          LIMIT $2
        `;

        const feedRes = await query(timelineSql, [req.user.did, limit]);

        const feed = [];
        for (const row of feedRes.rows) {
          // Circle filter
          if (row.data?.circle) {
            const circleOk = await canAccessCircle(req.user.did, row.data.circle);
            if (!circleOk) continue;
          }

          feed.push({
            post: {
              uri: formatAtUri(row.did, row.collection, row.rkey),
              cid: `bafy${sha256(row.data).slice(0, 32)}`,
              author: {
                did: row.did,
                handle: row.handle,
                displayName: row.display_name,
                avatar: row.avatar_url,
              },
              record: row.data,
              indexedAt: row.created_at,
            },
          });
        }

        return res.json({ feed });
      }

      // ---------------------------------------------------- exportAccount (Tracker #21)
      case 'org.z3social.repo.exportAccount': {
        if (!req.user) throw XRPCError.authRequired();

        // Export full user records for sovereign data portability
        const allRecords = await query(
          'SELECT collection, rkey, data, created_at, updated_at FROM records WHERE did = $1 ORDER BY created_at ASC',
          [req.user.did]
        );

        const circleRes = await query('SELECT id, name, description, created_at FROM circles WHERE owner_did = $1', [req.user.did]);

        return res.json({
          version: '1.0',
          exportedAt: new Date().toISOString(),
          account: {
            did: req.user.did,
            handle: req.user.handle,
            email: req.user.email,
            displayName: req.user.display_name,
            bio: req.user.bio,
            createdAt: req.user.created_at,
          },
          circles: circleRes.rows,
          records: allRecords.rows.map((r) => ({
            uri: formatAtUri(req.user.did, r.collection, r.rkey),
            collection: r.collection,
            rkey: r.rkey,
            value: r.data,
            createdAt: r.created_at,
          })),
        });
      }

      default:
        throw XRPCError.methodNotImplemented(nsid);
    }
  } catch (err) {
    if (err instanceof XRPCError) {
      return res.status(err.status).json(err.toJSON());
    }
    console.error(`[XRPC ${nsid} Error]:`, err);
    return res.status(500).json(XRPCError.invalidRequest('Internal XRPC error').toJSON());
  }
});

export default xrpcRouter;

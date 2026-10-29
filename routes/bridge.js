import express from 'express';
import { query } from '../config/db.js';
import { hashPassword, verifyPassword, generateKeyPair } from '../lib/crypto.js';
import { createToken, requireAuth } from '../middleware/auth.js';
import { XRPCError, assertValidRecord } from '../lib/lex/index.js';
import { generateTID, formatAtUri } from '../lib/syntax.js';

export const bridgeRouter = express.Router();

function accountToMastodon(acc) {
  const isAdmin = acc.handle === 'ivanalbrieu' || acc.is_admin || false;
  return {
    id: acc.did,
    username: acc.handle,
    acct: acc.handle,
    display_name: acc.display_name || acc.handle,
    locked: !!acc.is_private,
    bot: false,
    created_at: acc.created_at,
    note: acc.bio || '',
    url: `http://localhost:3036/@${acc.handle}`,
    avatar: acc.avatar_url || '/media/logo.png',
    avatar_static: acc.avatar_url || '/media/logo.png',
    header: acc.banner_url || '/media/z3-central-cover.jpg',
    header_static: acc.banner_url || '/media/z3-central-cover.jpg',
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    fields: [],
    emojis: [],
    admin: isAdmin,
    moderator: isAdmin,
    verified: true,
    pleroma: {
      tags: ['verified'],
      is_admin: isAdmin,
      is_moderator: isAdmin,
      relationship: {},
    },
  };
}

function recordToStatus(row) {
  const data = row.data || {};
  return {
    id: row.rkey,
    uri: formatAtUri(row.did, row.collection, row.rkey),
    url: `http://localhost:3036/@${row.handle}/posts/${row.rkey}`,
    account: accountToMastodon({
      did: row.did,
      handle: row.handle,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      banner_url: row.banner_url,
      created_at: row.created_at,
    }),
    content: data.text || '',
    created_at: data.createdAt || row.created_at,
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    favourited: false,
    reblogged: false,
    muted: false,
    pinned: false,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    media_attachments: [],
    mentions: [],
    tags: (data.tags || []).map((t) => ({ name: t, url: `/tags/${t}` })),
    emojis: [],
    card: null,
    poll: null,
    group: data.group ? { id: data.group, title: data.group } : null,
    pleroma: {
      quote_visible: true,
    },
  };
}

// ------------------------------------------------ Instance & Metadata
bridgeRouter.get('/api/v1/instance', (req, res) => {
  res.json({
    uri: 'z3.social',
    title: 'Z3 Social',
    short_description: 'Sovereign social engine backed by PostgreSQL',
    description: 'Sovereign social engine backed by PostgreSQL',
    email: 'contact@z3.social',
    version: '2.7.2 (compatible; Akkoma 3.10.4+soapbox)',
    urls: { streaming_api: 'ws://localhost:3036' },
    stats: { user_count: 1, status_count: 0, domain_count: 0 },
    thumbnail: '/media/logo.png',
    languages: ['en'],
    registrations: true,
    approval_required: false,
    invites_enabled: false,
    configuration: {
      statuses: { max_characters: 5000, max_media_attachments: 4 },
      media_attachments: { supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4'] },
    },
    pleroma: {
      metadata: {
        features: ['groups', 'direct_messages', 'pleroma_api', 'profile_directory', 'quote_posting'],
        staff_accounts: ['/users/ivanalbrieu'],
      },
      vapid_public_key: 'test',
    },
  });
});

bridgeRouter.get('/nodeinfo/2.1.json', (req, res) => {
  res.json({
    version: '2.1',
    software: { name: 'z3-engine', version: '1.0.0', repository: 'https://github.com/Z3Social/Z3-Engine' },
    protocols: ['atproto-derivative'],
    services: { inbound: [], outbound: [] },
    openRegistrations: true,
    usage: { users: { total: 1 } },
    metadata: { nodeName: 'Z3 Social' },
  });
});

bridgeRouter.get('/api/pleroma/frontend_configurations', (req, res) => {
  res.json({
    soapbox: {
      brandColor: '#1d9bf0',
      logo: '/media/logo.png',
      siteTitle: 'Z3 Social',
    },
  });
});

// ------------------------------------------------ Auth & Accounts
bridgeRouter.get('/api/v1/accounts/verify_credentials', requireAuth, (req, res) => {
  res.json(accountToMastodon(req.user));
});

bridgeRouter.get('/api/v1/accounts/relationships', (req, res) => {
  const ids = Array.isArray(req.query.id) ? req.query.id : [req.query.id].filter(Boolean);
  res.json(
    ids.map((id) => ({
      id,
      following: false,
      showing_reblogs: true,
      notifying: false,
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    }))
  );
});

bridgeRouter.get('/api/v1/accounts/:id', async (req, res) => {
  const { id } = req.params;
  const accRes = await query(
    'SELECT did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE (did = $1 OR handle = $1 OR LOWER(handle) = LOWER($1)) AND deleted_at IS NULL',
    [id]
  );
  if (!accRes.rows.length) {
    return res.status(404).json({ error: 'Account not found' });
  }
  res.json(accountToMastodon(accRes.rows[0]));
});

bridgeRouter.post('/api/v1/apps', (req, res) => {
  res.json({
    id: 'z3-app',
    name: req.body.client_name || 'Z3-UI',
    website: 'https://z3.social',
    client_id: 'z3-client-id',
    client_secret: 'z3-client-secret',
  });
});

bridgeRouter.post('/oauth/token', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Username and password required.' });
  }

  const cleanUser = String(username).trim();
  const accRes = await query(
    'SELECT did, handle, email, password_hash, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE (LOWER(handle) = LOWER($1) OR LOWER(email) = LOWER($1)) AND deleted_at IS NULL',
    [cleanUser]
  );

  if (!accRes.rows.length) {
    return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid credentials.' });
  }

  const user = accRes.rows[0];
  const isValid = await verifyPassword(password, user.password_hash);
  if (!isValid) {
    return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid credentials.' });
  }

  const token = createToken({ did: user.did, handle: user.handle });
  res.json({
    access_token: token,
    token_type: 'Bearer',
    scope: 'read write follow push',
    created_at: Math.floor(Date.now() / 1000),
  });
});

bridgeRouter.post('/api/v1/accounts', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required.' });
  }

  try {
    const passwordHash = await hashPassword(password);
    const did = `did:z3:${username.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
    const { publicKey } = generateKeyPair();

    const result = await query(
      `INSERT INTO accounts (did, handle, email, password_hash, public_key, display_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at`,
      [did, username, email, passwordHash, publicKey, username]
    );

    const newAccount = result.rows[0];
    const token = createToken({ did: newAccount.did, handle: newAccount.handle });

    res.json({
      access_token: token,
      token_type: 'Bearer',
      scope: 'read write follow push',
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(422).json({ error: 'Username or email is already taken.' });
    }
    console.error('[Register Error]:', err);
    res.status(500).json({ error: 'Internal registration error.' });
  }
});

// ------------------------------------------------ Statuses & Timelines
// POST /api/v1/statuses -> Translates into putRecord (app.bsky.feed.post)
bridgeRouter.post('/api/v1/statuses', requireAuth, async (req, res) => {
  const text = (req.body.status || req.body.text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Status content cannot be empty.' });
  }

  const rkey = generateTID();
  const record = {
    text,
    createdAt: new Date().toISOString(),
    group: req.body.group_id || undefined,
  };

  try {
    // Validate with Lexicon engine
    assertValidRecord('app.bsky.feed.post', record);

    const insertSql = `
      INSERT INTO records (did, collection, rkey, data, created_at, updated_at)
      VALUES ($1, 'app.bsky.feed.post', $2, $3, NOW(), NOW())
      RETURNING id, did, collection, rkey, data, created_at
    `;

    const row = await query(insertSql, [req.user.did, rkey, JSON.stringify(record)]);
    const resultStatus = recordToStatus({
      ...row.rows[0],
      handle: req.user.handle,
      display_name: req.user.display_name,
      avatar_url: req.user.avatar_url,
      banner_url: req.user.banner_url,
    });

    res.json(resultStatus);
  } catch (err) {
    console.error('[Create Status Bridge Error]:', err);
    res.status(500).json({ error: 'Failed to create status.' });
  }
});

bridgeRouter.get('/api/v1/statuses/:id', async (req, res) => {
  const { id } = req.params;
  const rows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [id]
  );
  if (!rows.rows.length) return res.status(404).json({ error: 'Status not found' });
  res.json(recordToStatus(rows.rows[0]));
});

bridgeRouter.delete('/api/v1/statuses/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const delRes = await query(
    `DELETE FROM records WHERE rkey = $1 AND did = $2 AND collection = 'app.bsky.feed.post' RETURNING id`,
    [id, req.user.did]
  );
  if (!delRes.rows.length) return res.status(404).json({ error: 'Status not found or not owned by you.' });
  res.json({ id });
});

bridgeRouter.get(['/api/v1/timelines/home', '/api/v1/timelines/public'], async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 80);
    const rows = await query(
      `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
              a.handle, a.display_name, a.avatar_url, a.banner_url
       FROM records r
       JOIN accounts a ON a.did = r.did
       WHERE r.collection = 'app.bsky.feed.post' AND a.deleted_at IS NULL
       ORDER BY r.created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows.rows.map(recordToStatus));
  } catch (err) {
    console.error('[Timeline Bridge Error]:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------------------------ Empty compatibility endpoints
bridgeRouter.get('/api/v1/custom_emojis', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/announcements', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/notifications', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/markers', (req, res) => res.json({}));
bridgeRouter.get('/api/v1/scheduled_statuses', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/filters', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/lists', (req, res) => res.json([]));
bridgeRouter.get('/api/v1/preferences', (req, res) => res.json({}));
bridgeRouter.get('/api/v1/pleroma/admin/reports', (req, res) => res.json({ reports: [], total: 0 }));
bridgeRouter.get('/api/v1/pleroma/admin/users', (req, res) => res.json({ users: [], count: 0 }));
bridgeRouter.get('/api/v1/pleroma/admin/config', (req, res) => res.json({ configs: [] }));

export default bridgeRouter;

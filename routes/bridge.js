import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { query } from '../config/db.js';
import { hashPassword, verifyPassword, generateKeyPair } from '../lib/crypto.js';
import { createToken, requireAuth, optionalAuth } from '../middleware/auth.js';
import { XRPCError, assertValidRecord } from '../lib/lex/index.js';
import { generateTID, formatAtUri } from '../lib/syntax.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Uploads directory
const UPLOAD_DIR = [
  path.join(__dirname, '..', 'data', 'uploads'),
  path.join(__dirname, '..', '..', 'Z3-Backend', 'data', 'uploads'),
].find((p) => fs.existsSync(p)) || path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory media upload registry
const mediaUploads = new Map();

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};

// HTML escape helper
const escapeHtml = (str) =>
  String(str || '').replace(/[&<>'"]/g, (tag) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));

// Multipart form parser for avatar/banner/media uploads
function parseMultipart(buffer, boundary) {
  const parts = {};
  const files = {};
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = buffer.indexOf(boundaryBuffer);
  while (start !== -1) {
    const end = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length);
    if (end === -1) break;
    const part = buffer.slice(start + boundaryBuffer.length, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      const body = part.slice(headerEnd + 4, part.length - 2);
      const nameMatch = /name="([^"]+)"/.exec(headerStr);
      const filenameMatch = /filename="([^"]+)"/.exec(headerStr);
      const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
      if (nameMatch) {
        const name = nameMatch[1];
        if (filenameMatch) {
          files[name] = {
            filename: filenameMatch[1],
            contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
            data: body,
          };
        } else {
          parts[name] = body.toString('utf8');
        }
      }
    }
    start = end;
  }
  return { fields: parts, files };
}

function parseBodyOrMultipart(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
    const boundary = m ? (m[1] || m[2]) : null;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (boundary) {
        const parsed = parseMultipart(buf, boundary);
        req.body = Object.assign({}, req.body, parsed.fields);
        req.files = parsed.files;
      } else {
        req.files = {};
      }
      next();
    });
  } else {
    req.files = {};
    next();
  }
}

export const bridgeRouter = express.Router();

function accountToMastodon(acc) {
  const isAdmin = acc.handle === 'ivanalbrieu' || acc.is_admin || false;
  const fields = Array.isArray(acc.fields) ? acc.fields : [];
  const notePlain = acc.bio || '';
  const noteHtml = notePlain ? `<p>${escapeHtml(notePlain).replace(/\n/g, '<br/>')}</p>` : '';

  return {
    id: acc.did,
    username: acc.handle,
    acct: acc.handle,
    display_name: acc.display_name || acc.handle,
    locked: !!acc.is_private,
    bot: false,
    created_at: acc.created_at,
    note: noteHtml,
    url: `http://localhost:3036/@${acc.handle}`,
    avatar: acc.avatar_url || '/media/logo.png',
    avatar_static: acc.avatar_url || '/media/logo.png',
    header: acc.banner_url || '/media/z3-central-cover.jpg',
    header_static: acc.banner_url || '/media/z3-central-cover.jpg',
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    fields: fields,
    emojis: [],
    admin: isAdmin,
    moderator: isAdmin,
    verified: true,
    discoverable: true,
    source: {
      note: notePlain,
      fields: fields,
      privacy: acc.is_private ? 'private' : 'public',
      sensitive: false,
      pleroma: {
        actor_type: 'Person',
        discoverable: true,
      },
    },
    pleroma: {
      tags: ['verified'],
      is_admin: isAdmin,
      is_moderator: isAdmin,
      accepts_chat_messages: true,
      relationship: {},
      notification_settings: {
        block_from_strangers: false,
      },
    },
  };
}

async function recordToStatus(row, currentUserId = null) {
  const data = row.data || {};

  // Detect YouTube media or link
  const ytMedia = (data.media || []).find((m) => m.type === 'youtube');
  let ytId = null;
  if (ytMedia) {
    ytId = ytMedia.youtubeId || (/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i.exec(ytMedia.url) || [])[1];
  }
  if (!ytId && data.text) {
    ytId = (/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i.exec(data.text) || [])[1];
  }

  // Visual media attachments (images, videos, GIFs)
  const mediaAttachments = (data.media || [])
    .filter((m) => m.type !== 'youtube')
    .map((m, idx) => {
      const isVideo = m.type === 'video';
      return {
        id: `media-${idx}`,
        type: isVideo ? 'video' : 'image',
        url: m.url || '',
        preview_url: m.preview || m.preview_url || m.url || '',
        remote_url: null,
        description: m.description || m.title || '',
        blurhash: null,
        meta: {
          original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
          small: { width: 400, height: 300, size: '400x300', aspect: 1.33 },
        },
      };
    });

  // Auto-detect GIF links in text if no media attachments exist
  if (!mediaAttachments.length && data.text) {
    const gifMatch = /(https?:\/\/[^\s<>]+\.(?:gif|webp)(?:\?[^\s<>]*)?)/i.exec(data.text)
      || /(https?:\/\/(?:static\.)?klipy\.com\/[^\s<>]+)/i.exec(data.text);
    if (gifMatch) {
      mediaAttachments.push({
        id: `gif-0`,
        type: 'image',
        url: gifMatch[0],
        preview_url: gifMatch[0],
        remote_url: null,
        description: 'GIF',
        blurhash: null,
        meta: {},
      });
    }
  }

  // YouTube OpenGraph Card
  let card = null;
  if (ytId) {
    card = {
      url: ytMedia?.url || `https://www.youtube.com/watch?v=${ytId}`,
      title: ytMedia?.title || 'YouTube Video',
      description: 'Watch video on YouTube',
      type: 'video',
      author_name: 'YouTube',
      author_url: 'https://www.youtube.com',
      provider_name: 'YouTube',
      provider_url: 'https://www.youtube.com',
      html: `<iframe width="480" height="270" src="https://www.youtube.com/embed/${ytId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`,
      width: 480,
      height: 270,
      image: `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
      embed_url: `https://www.youtube.com/embed/${ytId}`,
      blurhash: null,
    };
  }

  // Format HTML content
  const htmlContent = `<p>${escapeHtml(data.text || '').replace(/\n/g, '<br/>')}</p>`;

  // Resolve Likes & Favourites
  const reactions = data.reactions || {};
  const favCount = Object.keys(reactions).reduce((sum, r) => sum + (reactions[r] || []).length, 0);
  const isFaved = Boolean(currentUserId && Object.values(reactions).some((arr) => Array.isArray(arr) && arr.includes(currentUserId)));

  // Resolve Reblogs
  const reblogs = Array.isArray(data.reblogs) ? data.reblogs : [];
  const isReblogged = Boolean(currentUserId && reblogs.includes(currentUserId));

  // Count Replies from records
  const allRecordsRes = await query('SELECT data FROM records WHERE collection = \'app.bsky.feed.post\'');
  const allRecords = allRecordsRes.rows || [];
  const repliesCount = allRecords.filter((r) => r.data && (r.data.in_reply_to_id === row.rkey || r.data.replyToId === row.rkey || r.data.postId === row.rkey)).length;

  // Resolve Group metadata if present
  let groupObj = null;
  const groupId = data.group || data.groupId;
  if (groupId) {
    const groupRes = await query('SELECT * FROM circles WHERE id = $1', [groupId]);
    const g = groupRes.rows[0];
    if (g) {
      groupObj = {
        id: g.id,
        title: g.name,
        name: g.name,
        slug: g.slug || g.id,
        preferredUsername: g.name,
        display_name: g.name,
        avatar: g.coverImage || g.cover || '/media/logo.png',
        header: g.coverImage || g.cover || '/media/z3-central-cover.jpg',
      };
    } else {
      groupObj = {
        id: groupId,
        title: groupId,
        name: groupId,
        slug: groupId,
        preferredUsername: groupId,
        display_name: groupId,
        avatar: '/media/logo.png',
        header: '/media/z3-central-cover.jpg',
      };
    }
  }

  // Nested Reblog target
  let reblogStatus = null;
  if (data.reblog_of_id) {
    const targetRows = await query(
      `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
              a.handle, a.display_name, a.avatar_url, a.banner_url
       FROM records r
       JOIN accounts a ON a.did = r.did
       WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
      [data.reblog_of_id]
    );
    if (targetRows.rows.length && targetRows.rows[0].rkey !== row.rkey) {
      reblogStatus = await recordToStatus(targetRows.rows[0], currentUserId);
    }
  }

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
    in_reply_to_id: data.in_reply_to_id || null,
    in_reply_to_account_id: null,
    content: htmlContent,
    created_at: data.createdAt || row.created_at,
    reblogs_count: reblogs.length,
    favourites_count: favCount,
    replies_count: repliesCount,
    favourited: isFaved,
    reblogged: isReblogged,
    muted: false,
    pinned: !!data.pinned,
    sensitive: false,
    spoiler_text: '',
    visibility: 'public',
    media_attachments: mediaAttachments,
    mentions: [],
    tags: (data.tags || []).map((t) => ({ name: t, url: `/tags/${t}` })),
    emojis: [],
    card: card,
    poll: null,
    group: groupObj,
    reblog: reblogStatus,
    pleroma: {
      quote_visible: true,
      emoji_reactions: [],
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
    stats: { user_count: 2, status_count: 16, domain_count: 0 },
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
        features: ['groups', 'chats', 'pleroma_chat_messages', 'direct_messages', 'pleroma_api', 'profile_directory', 'quote_posting'],
        staff_accounts: ['/users/ivanalbrieu'],
      },
      vapid_public_key: 'test',
    },
  });
});

bridgeRouter.get(['/nodeinfo/2.0', '/nodeinfo/2.1.json'], (req, res) => {
  res.json({
    version: '2.1',
    software: { name: 'akkoma', version: '3.10.4', repository: 'https://github.com/Z3Social/Z3-Engine' },
    protocols: ['atproto-derivative'],
    services: { inbound: [], outbound: [] },
    openRegistrations: true,
    usage: { users: { total: 2 } },
    metadata: {
      nodeName: 'Z3 Social',
      features: ['groups', 'chats', 'pleroma_chat_messages', 'direct_messages', 'pleroma_api', 'profile_directory', 'quote_posting'],
      staffAccounts: ['/users/ivanalbrieu'],
    },
  });
});

bridgeRouter.get('/.well-known/nodeinfo', (req, res) => {
  const host = req.get('host') || 'localhost:3036';
  res.json({
    links: [
      { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${req.protocol}://${host}/nodeinfo/2.0` },
      { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${req.protocol}://${host}/nodeinfo/2.1.json` },
    ],
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

// Update credentials (supports JSON and multipart/form-data for avatar/banner)
async function handleUpdateCredentials(req, res) {
  try {
    const body = req.body || {};
    const files = req.files || {};
    const u = req.user;

    const updates = [];
    const params = [];
    let pIdx = 1;

    if (body.display_name !== undefined) {
      updates.push(`display_name = $${pIdx++}`);
      params.push(String(body.display_name).trim());
    }
    if (body.note !== undefined) {
      updates.push(`bio = $${pIdx++}`);
      params.push(String(body.note));
    }
    if (body.locked !== undefined) {
      updates.push(`is_private = $${pIdx++}`);
      params.push(body.locked === true || body.locked === 'true');
    }

    // Avatar upload (multipart or base64 data url)
    if (files.avatar && files.avatar.data && files.avatar.data.length > 0) {
      const origExt = path.extname(files.avatar.filename || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
      const ext = origExt || 'png';
      const fname = `avatar-${u.handle}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), files.avatar.data);
      updates.push(`avatar_url = $${pIdx++}`);
      params.push(`/uploads/${fname}`);
    } else if (typeof body.avatar === 'string' && body.avatar.startsWith('data:')) {
      const m = /^data:([\w.+/-]+);base64,(.+)$/s.exec(body.avatar);
      if (m) {
        const ext = MIME_EXT[m[1]] || 'png';
        const fname = `avatar-${u.handle}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(m[2], 'base64'));
        updates.push(`avatar_url = $${pIdx++}`);
        params.push(`/uploads/${fname}`);
      }
    }

    // Header upload
    if (files.header && files.header.data && files.header.data.length > 0) {
      const origExt = path.extname(files.header.filename || '').slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
      const ext = origExt || 'jpg';
      const fname = `header-${u.handle}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), files.header.data);
      updates.push(`banner_url = $${pIdx++}`);
      params.push(`/uploads/${fname}`);
    } else if (typeof body.header === 'string' && body.header.startsWith('data:')) {
      const m = /^data:([\w.+/-]+);base64,(.+)$/s.exec(body.header);
      if (m) {
        const ext = MIME_EXT[m[1]] || 'jpg';
        const fname = `header-${u.handle}-${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), Buffer.from(m[2], 'base64'));
        updates.push(`banner_url = $${pIdx++}`);
        params.push(`/uploads/${fname}`);
      }
    }

    if (updates.length > 0) {
      params.push(req.user.did);
      const sql = `UPDATE accounts SET ${updates.join(', ')} WHERE did = $${pIdx} RETURNING *`;
      const updateRes = await query(sql, params);
      if (updateRes.rows.length) {
        return res.json(accountToMastodon(updateRes.rows[0]));
      }
    }

    res.json(accountToMastodon(req.user));
  } catch (err) {
    console.error('[Update Credentials Error]:', err);
    res.status(500).json({ error: 'Failed to update credentials' });
  }
}

bridgeRouter.patch('/api/v1/accounts/update_credentials', parseBodyOrMultipart, requireAuth, handleUpdateCredentials);
bridgeRouter.post('/api/v1/accounts/update_credentials', parseBodyOrMultipart, requireAuth, handleUpdateCredentials);

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

bridgeRouter.get('/api/v1/accounts/lookup', async (req, res) => {
  const acct = String(req.query.acct || '').trim().toLowerCase().replace(/^@/, '');
  const accRes = await query(
    'SELECT did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE (did = $1 OR handle = $1 OR LOWER(handle) = LOWER($1)) AND deleted_at IS NULL',
    [acct]
  );
  if (!accRes.rows.length) return res.status(404).json({ error: 'Record not found' });
  res.json(accountToMastodon(accRes.rows[0]));
});

bridgeRouter.get(['/api/v1/accounts/:id', '/users/:id'], async (req, res) => {
  const { id } = req.params;
  const cleanId = String(id).replace(/^@/, '');
  const accRes = await query(
    'SELECT did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE (did = $1 OR handle = $1 OR LOWER(handle) = LOWER($1)) AND deleted_at IS NULL',
    [cleanId]
  );
  if (!accRes.rows.length) {
    return res.status(404).json({ error: 'Account not found' });
  }
  res.json(accountToMastodon(accRes.rows[0]));
});

// Follow & Unfollow
bridgeRouter.post('/api/v1/accounts/:id/follow', requireAuth, (req, res) => {
  res.json({
    id: req.params.id,
    following: true,
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
  });
});

bridgeRouter.post('/api/v1/accounts/:id/unfollow', requireAuth, (req, res) => {
  res.json({
    id: req.params.id,
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
  });
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

// ------------------------------------------------ Media Upload Endpoints
function handleMediaUpload(req, res) {
  const id = crypto.randomUUID();
  if (req.body && req.body.url) {
    const url = req.body.url;
    const isVideo = url.endsWith('.mp4') || url.endsWith('.webm');
    const att = {
      id,
      type: isVideo ? 'video' : 'image',
      url,
      preview_url: req.body.preview_url || url,
      remote_url: url,
      text_url: url,
      meta: {
        original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
        small: { width: 400, height: 300, size: '400x300', aspect: 1.33 },
      },
      description: req.body.description || '',
    };
    mediaUploads.set(id, att);
    return res.json(att);
  }

  const fileObj = (req.files && (req.files.file || Object.values(req.files)[0])) || null;
  if (!fileObj || !fileObj.data) {
    return res.status(400).json({ error: 'No file provided' });
  }

  const ext = (path.extname(fileObj.filename || '').replace(/[^a-z0-9]/gi, '') || 'png').toLowerCase();
  const fname = `media-${Date.now()}-${id.slice(0, 8)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), fileObj.data);
  const url = `/uploads/${fname}`;
  const isVideo = (fileObj.contentType && fileObj.contentType.startsWith('video/')) || ['mp4', 'webm', 'mov'].includes(ext);

  const att = {
    id,
    type: isVideo ? 'video' : 'image',
    url,
    preview_url: url,
    remote_url: null,
    text_url: null,
    meta: {
      original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
      small: { width: 400, height: 300, size: '400x300', aspect: 1.33 },
    },
    description: req.body.description || '',
  };
  mediaUploads.set(id, att);
  res.json(att);
}

bridgeRouter.post('/api/v1/media', parseBodyOrMultipart, requireAuth, handleMediaUpload);
bridgeRouter.post('/api/v2/media', parseBodyOrMultipart, requireAuth, handleMediaUpload);
bridgeRouter.get('/api/v1/media/:id', (req, res) => {
  const att = mediaUploads.get(req.params.id);
  if (att) return res.json(att);
  res.status(404).json({ error: 'Media not found' });
});
bridgeRouter.put('/api/v1/media/:id', parseBodyOrMultipart, requireAuth, (req, res) => {
  const att = mediaUploads.get(req.params.id);
  if (att) {
    if (req.body.description !== undefined) att.description = req.body.description;
    return res.json(att);
  }
  res.status(404).json({ error: 'Media not found' });
});

// ------------------------------------------------ Statuses & Timelines
// POST /api/v1/statuses -> Translates into putRecord (app.bsky.feed.post)
bridgeRouter.post('/api/v1/statuses', requireAuth, async (req, res) => {
  const text = (req.body.status || req.body.text || req.body.content || '').trim();
  const mediaIds = Array.isArray(req.body.media_ids) ? req.body.media_ids : (req.body.media_ids ? [req.body.media_ids] : []);

  if (!text && !mediaIds.length) {
    return res.status(400).json({ error: 'Status content cannot be empty.' });
  }

  const attachedMedia = [];
  for (const mid of mediaIds) {
    if (mediaUploads.has(mid)) {
      const item = mediaUploads.get(mid);
      attachedMedia.push({
        type: item.type === 'video' ? 'video' : 'image',
        url: item.url,
        preview: item.preview_url,
        description: item.description || '',
      });
    }
  }

  const rkey = generateTID();
  const inReplyToId = req.body.in_reply_to_id || undefined;
  const groupId = req.body.group_id || undefined;

  const record = {
    text,
    createdAt: new Date().toISOString(),
    group: groupId,
    in_reply_to_id: inReplyToId,
    media: attachedMedia.length ? attachedMedia : undefined,
    reactions: {},
    reblogs: [],
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
    const resultStatus = await recordToStatus({
      ...row.rows[0],
      handle: req.user.handle,
      display_name: req.user.display_name,
      avatar_url: req.user.avatar_url,
      banner_url: req.user.banner_url,
    }, req.user.did);

    res.json(resultStatus);
  } catch (err) {
    console.error('[Create Status Bridge Error]:', err);
    res.status(500).json({ error: 'Failed to create status.' });
  }
});

// GET /api/v1/statuses/:id/context -> Thread hierarchy with ancestors and descendants
bridgeRouter.get('/api/v1/statuses/:id/context', optionalAuth, async (req, res) => {
  const currentId = req.params.id;
  const currentRows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [currentId]
  );
  if (!currentRows.rows.length) return res.status(404).json({ error: 'Status not found' });

  const userId = req.user ? req.user.did : null;
  const allRowsRes = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.collection = 'app.bsky.feed.post'`
  );
  const allPosts = allRowsRes.rows || [];

  const visited = new Set([currentId]);

  // 1. Resolve Ancestors
  const ancestors = [];
  let parentId = currentRows.rows[0].data?.in_reply_to_id || currentRows.rows[0].data?.postId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parentRow = allPosts.find((p) => p.rkey === parentId);
    if (parentRow) {
      ancestors.unshift(await recordToStatus(parentRow, userId));
      parentId = parentRow.data?.in_reply_to_id || parentRow.data?.postId;
    } else {
      break;
    }
  }

  // 2. Resolve Descendants
  const descendants = [];
  const findChildren = async (id) => {
    const directChildren = allPosts.filter((p) => {
      const d = p.data || {};
      return (d.in_reply_to_id === id || d.replyToId === id || d.postId === id) && p.rkey !== id;
    });
    for (const child of directChildren) {
      if (!visited.has(child.rkey)) {
        visited.add(child.rkey);
        descendants.push(await recordToStatus(child, userId));
        await findChildren(child.rkey);
      }
    }
  };
  await findChildren(currentId);

  res.json({ ancestors, descendants });
});

bridgeRouter.get('/api/v1/statuses/:id', optionalAuth, async (req, res) => {
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
  const status = await recordToStatus(rows.rows[0], req.user ? req.user.did : null);
  res.json(status);
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

// ------------------------------------------------ Favourite & Unfavourite
bridgeRouter.post('/api/v1/statuses/:id/favourite', requireAuth, async (req, res) => {
  const { id } = req.params;
  const targetRows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [id]
  );
  if (!targetRows.rows.length) return res.status(404).json({ error: 'Status not found' });

  const row = targetRows.rows[0];
  const data = row.data || {};
  data.reactions = data.reactions || {};
  if (!data.reactions['like']) data.reactions['like'] = [];
  if (!data.reactions['like'].includes(req.user.did)) {
    data.reactions['like'].push(req.user.did);
  }

  await query('UPDATE records SET data = $1, updated_at = NOW() WHERE rkey = $2 RETURNING *', [
    JSON.stringify(data),
    id,
  ]);

  row.data = data;
  const updated = await recordToStatus(row, req.user.did);
  res.json(updated);
});

bridgeRouter.post('/api/v1/statuses/:id/unfavourite', requireAuth, async (req, res) => {
  const { id } = req.params;
  const targetRows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [id]
  );
  if (!targetRows.rows.length) return res.status(404).json({ error: 'Status not found' });

  const row = targetRows.rows[0];
  const data = row.data || {};
  data.reactions = data.reactions || {};
  Object.keys(data.reactions).forEach((k) => {
    if (Array.isArray(data.reactions[k])) {
      data.reactions[k] = data.reactions[k].filter((did) => did !== req.user.did);
    }
  });

  await query('UPDATE records SET data = $1, updated_at = NOW() WHERE rkey = $2 RETURNING *', [
    JSON.stringify(data),
    id,
  ]);

  row.data = data;
  const updated = await recordToStatus(row, req.user.did);
  res.json(updated);
});

bridgeRouter.get('/api/v1/favourites', requireAuth, async (req, res) => {
  const rowsRes = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.collection = 'app.bsky.feed.post'`
  );
  const favRows = rowsRes.rows.filter((r) => {
    const rx = r.data?.reactions || {};
    return Object.values(rx).some((arr) => Array.isArray(arr) && arr.includes(req.user.did));
  });

  const statuses = await Promise.all(favRows.map((r) => recordToStatus(r, req.user.did)));
  res.json(statuses);
});

// ------------------------------------------------ Reblog & Unreblog
bridgeRouter.post('/api/v1/statuses/:id/reblog', requireAuth, async (req, res) => {
  const { id } = req.params;
  const targetRows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [id]
  );
  if (!targetRows.rows.length) return res.status(404).json({ error: 'Status not found' });

  const targetRow = targetRows.rows[0];
  const targetData = targetRow.data || {};
  targetData.reblogs = targetData.reblogs || [];
  if (!targetData.reblogs.includes(req.user.did)) {
    targetData.reblogs.push(req.user.did);
  }

  await query('UPDATE records SET data = $1, updated_at = NOW() WHERE rkey = $2 RETURNING *', [
    JSON.stringify(targetData),
    id,
  ]);
  targetRow.data = targetData;

  // Create or retrieve reblog post record
  const allReblogs = await query('SELECT * FROM records WHERE did = $1 AND collection = \'app.bsky.feed.post\'', [req.user.did]);
  let reblogRow = allReblogs.rows.find((r) => r.data && r.data.reblog_of_id === id);
  if (!reblogRow) {
    const rkey = generateTID();
    const reblogData = {
      text: '',
      createdAt: new Date().toISOString(),
      reblog_of_id: id,
    };
    const insRes = await query(
      `INSERT INTO records (did, collection, rkey, data, created_at, updated_at)
       VALUES ($1, 'app.bsky.feed.post', $2, $3, NOW(), NOW())
       RETURNING id, did, collection, rkey, data, created_at`,
      [req.user.did, rkey, JSON.stringify(reblogData)]
    );
    reblogRow = {
      ...insRes.rows[0],
      handle: req.user.handle,
      display_name: req.user.display_name,
      avatar_url: req.user.avatar_url,
      banner_url: req.user.banner_url,
    };
  }

  const targetStatus = await recordToStatus(targetRow, req.user.did);
  const wrappingStatus = await recordToStatus(reblogRow, req.user.did);
  res.json({
    ...wrappingStatus,
    reblog: targetStatus,
  });
});

bridgeRouter.post('/api/v1/statuses/:id/unreblog', requireAuth, async (req, res) => {
  const { id } = req.params;
  const targetRows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.rkey = $1 AND r.collection = 'app.bsky.feed.post'`,
    [id]
  );
  if (!targetRows.rows.length) return res.status(404).json({ error: 'Status not found' });

  const targetRow = targetRows.rows[0];
  const targetData = targetRow.data || {};
  targetData.reblogs = (targetData.reblogs || []).filter((did) => did !== req.user.did);

  await query('UPDATE records SET data = $1, updated_at = NOW() WHERE rkey = $2 RETURNING *', [
    JSON.stringify(targetData),
    id,
  ]);
  targetRow.data = targetData;

  // Delete user's reblog post record
  const allReblogs = await query('SELECT * FROM records WHERE did = $1 AND collection = \'app.bsky.feed.post\'', [req.user.did]);
  const reblogRec = allReblogs.rows.find((r) => r.data && r.data.reblog_of_id === id);
  if (reblogRec) {
    await query('DELETE FROM records WHERE rkey = $1 AND did = $2', [reblogRec.rkey, req.user.did]);
  }

  const updatedStatus = await recordToStatus(targetRow, req.user.did);
  res.json(updatedStatus);
});

// ------------------------------------------------ Timelines
bridgeRouter.get(['/api/v1/timelines/home', '/api/v1/timelines/public'], optionalAuth, async (req, res) => {
  try {
    const isHome = req.path.includes('/home');
    const viewerDid = req.user ? req.user.did : null;

    const rows = await query(
      `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
              a.handle, a.display_name, a.avatar_url, a.banner_url
       FROM records r
       JOIN accounts a ON a.did = r.did
       WHERE r.collection = 'app.bsky.feed.post' AND a.deleted_at IS NULL
       ORDER BY r.created_at DESC`
    );

    const circlesRes = await query('SELECT * FROM circles WHERE 1=1');
    const allGroups = circlesRes.rows || [];

    // Filter group posts
    const filteredRows = rows.rows.filter((row) => {
      const data = row.data || {};
      const groupId = data.group || data.groupId;

      // Global non-group posts are always shown
      if (!groupId) return true;

      // Group post: check membership
      const grp = allGroups.find((g) => g.id === groupId || g.slug === groupId);
      if (!grp) return true; // If group no longer exists or public

      const isMember = viewerDid ? (grp.members || []).some((m) => m.userId === viewerDid) : false;

      // In home feed: only show group post if viewer is a member
      if (isHome) {
        return isMember;
      }

      // In public feed: show if group is public, or if viewer is a member
      return grp.privacy === 'public' || isMember;
    });

    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 80);
    const sliced = filteredRows.slice(0, limit);
    const statuses = await Promise.all(sliced.map((r) => recordToStatus(r, viewerDid)));

    res.json(statuses);
  } catch (err) {
    console.error('[Timeline Bridge Error]:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Accounts statuses timeline
bridgeRouter.get('/api/v1/accounts/:id/statuses', optionalAuth, async (req, res) => {
  const { id } = req.params;
  const cleanId = String(id).replace(/^@/, '');
  const accRes = await query(
    'SELECT did FROM accounts WHERE (did = $1 OR handle = $1 OR LOWER(handle) = LOWER($1)) AND deleted_at IS NULL',
    [cleanId]
  );
  if (!accRes.rows.length) return res.json([]);
  const targetDid = accRes.rows[0].did;

  const rows = await query(
    `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
            a.handle, a.display_name, a.avatar_url, a.banner_url
     FROM records r
     JOIN accounts a ON a.did = r.did
     WHERE r.did = $1 AND r.collection = 'app.bsky.feed.post' AND a.deleted_at IS NULL
     ORDER BY r.created_at DESC`,
    [targetDid]
  );

  const statuses = await Promise.all(rows.rows.map((r) => recordToStatus(r, req.user ? req.user.did : null)));
  res.json(statuses);
});

// ------------------------------------------------ Groups Endpoints (Z3 Sovereign Communities)
function formatGroupResponse(g, isMember = false, isAdmin = false) {
  const noteHtml = `<p>${escapeHtml(g.description || '')}</p>`;
  return {
    id: g.id,
    title: g.name,
    slug: g.slug || g.id,
    name: g.slug || g.id,
    preferredUsername: g.name,
    display_name: g.name,
    summary: noteHtml,
    note: noteHtml,
    description: g.description || '',
    avatar: g.coverImage || g.cover || '/media/logo.png',
    header: g.coverImage || g.cover || '/media/z3-central-cover.jpg',
    banner: g.coverImage || g.cover || '/media/z3-central-cover.jpg',
    cover_image_url: g.coverImage || g.cover || '/media/z3-central-cover.jpg',
    member_count: (g.members || []).length,
    members_count: (g.members || []).length,
    visibility: g.privacy || 'public',
    privacy: g.privacy || 'public',
    is_member: isMember,
    is_admin: isAdmin,
    moderators: [],
    rules: g.rules || [],
  };
}

bridgeRouter.get('/api/v1/groups', optionalAuth, async (req, res) => {
  try {
    const groupsRes = await query('SELECT * FROM circles WHERE 1=1');
    const groups = groupsRes.rows || [];
    const viewerDid = req.user ? req.user.did : null;

    res.json(
      groups.map((g) => {
        const isMember = viewerDid ? (g.members || []).some((m) => m.userId === viewerDid) : false;
        const isAdmin = viewerDid ? (g.members || []).some((m) => m.userId === viewerDid && m.role === 'admin') : false;
        return formatGroupResponse(g, isMember, isAdmin);
      })
    );
  } catch {
    res.json([]);
  }
});

bridgeRouter.get('/api/v1/groups/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const gRes = await query('SELECT * FROM circles WHERE id = $1', [id]);
    if (!gRes.rows.length) return res.status(404).json({ error: 'Group not found' });
    const g = gRes.rows[0];
    const viewerDid = req.user ? req.user.did : null;
    const isMember = viewerDid ? (g.members || []).some((m) => m.userId === viewerDid) : false;
    const isAdmin = viewerDid ? (g.members || []).some((m) => m.userId === viewerDid && m.role === 'admin') : false;

    res.json(formatGroupResponse(g, isMember, isAdmin));
  } catch {
    res.status(404).json({ error: 'Group not found' });
  }
});

bridgeRouter.get('/api/v1/groups/:id/relationships', optionalAuth, async (req, res) => {
  const { id } = req.params;
  const gRes = await query('SELECT * FROM circles WHERE id = $1', [id]);
  const g = gRes.rows[0];
  const viewerDid = req.user ? req.user.did : null;
  const isMember = (g && viewerDid) ? (g.members || []).some((m) => m.userId === viewerDid) : false;
  const isAdmin = (g && viewerDid) ? (g.members || []).some((m) => m.userId === viewerDid && m.role === 'admin') : false;

  const result = [{ id, member: isMember, admin: isAdmin }];
  if (g && g.slug && g.slug !== id) {
    result.push({ id: g.slug, member: isMember, admin: isAdmin });
  }
  res.json(result);
});

bridgeRouter.post('/api/v1/groups/:id/accounts', requireAuth, async (req, res) => {
  const { id } = req.params;
  const gRes = await query('SELECT * FROM circles WHERE id = $1', [id]);
  if (!gRes.rows.length) return res.status(404).json({ error: 'Group not found' });
  const g = gRes.rows[0];
  g.members = g.members || [];
  if (!g.members.some((m) => m.userId === req.user.did)) {
    g.members.push({ userId: req.user.did, role: 'member', joinedAt: new Date().toISOString() });
    await query('UPDATE circles SET members = $1 WHERE id = $2', [g.members, g.id]);
  }
  res.json({ id: g.id, member: true });
});

bridgeRouter.delete('/api/v1/groups/:id/accounts', requireAuth, async (req, res) => {
  const { id } = req.params;
  const gRes = await query('SELECT * FROM circles WHERE id = $1', [id]);
  if (!gRes.rows.length) return res.status(404).json({ error: 'Group not found' });
  const g = gRes.rows[0];
  g.members = (g.members || []).filter((m) => m.userId !== req.user.did);
  await query('UPDATE circles SET members = $1 WHERE id = $2', [g.members, g.id]);
  res.json({ id: g.id, member: false });
});

bridgeRouter.get('/api/v1/groups/:id/accounts', async (req, res) => {
  const { id } = req.params;
  const gRes = await query('SELECT * FROM circles WHERE id = $1', [id]);
  if (!gRes.rows.length) return res.status(404).json({ error: 'Group not found' });
  const g = gRes.rows[0];
  const members = [];
  for (const m of (g.members || [])) {
    const acc = await query('SELECT * FROM accounts WHERE did = $1', [m.userId]);
    if (acc.rows.length) members.push(accountToMastodon(acc.rows[0]));
  }
  res.json(members);
});

bridgeRouter.get('/api/v1/timelines/group/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await query(
      `SELECT r.did, r.collection, r.rkey, r.data, r.created_at,
              a.handle, a.display_name, a.avatar_url, a.banner_url
       FROM records r
       JOIN accounts a ON a.did = r.did
       WHERE r.collection = 'app.bsky.feed.post' AND (r.data->>'group' = $1 OR r.data->>'groupId' = $1)
       ORDER BY r.created_at DESC`,
      [id]
    );
    const statuses = await Promise.all(rows.rows.map((r) => recordToStatus(r, req.user ? req.user.did : null)));
    res.json(statuses);
  } catch (err) {
    res.json([]);
  }
});

// Helper to lookup account row by did or handle
async function getAccountByDidOrHandle(idOrHandle) {
  if (!idOrHandle) return null;
  const clean = String(idOrHandle).replace(/^@/, '');
  const res = await query(
    'SELECT did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE (did = $1 OR handle = $1 OR LOWER(handle) = LOWER($1)) AND deleted_at IS NULL',
    [clean]
  );
  return res.rows[0] || null;
}

// Convert direct message DB record to Pleroma chat message object
function dmToChatMessage(m, chatId) {
  const reactionsMap = m.reactions || {};
  const emojiReactions = Object.entries(reactionsMap)
    .filter(([, ids]) => ids && ids.length)
    .map(([name, ids]) => ({
      name,
      count: ids.length,
      me: Boolean(ids.includes(m.sender_did)),
    }));

  return {
    id: String(m.id),
    chat_id: String(chatId),
    account_id: m.sender_did,
    content: m.ciphertext,
    created_at: m.created_at,
    unread: !m.read_at,
    attachment: m.media_url
      ? {
          id: `media-${m.id}`,
          type: 'image',
          url: m.media_url,
          preview_url: m.media_url,
          remote_url: null,
          description: '',
        }
      : null,
    card: null,
    emojis: [],
    emoji_reactions: emojiReactions,
  };
}

// Format a single chat thread summary
async function buildChatSummary(otherAccount, currentDid) {
  const res = await query(
    'SELECT * FROM direct_messages WHERE (sender_did = $1 AND recipient_did = $2) OR (sender_did = $2 AND recipient_did = $1) ORDER BY created_at ASC',
    [currentDid, otherAccount.did]
  );
  const thread = res.rows || [];
  const last = thread.length ? thread[thread.length - 1] : null;
  const unreadCount = thread.filter((m) => m.recipient_did === currentDid && !m.read_at).length;

  return {
    id: otherAccount.did,
    account: accountToMastodon(otherAccount),
    unread: unreadCount,
    last_message: last ? dmToChatMessage(last, otherAccount.did) : null,
    updated_at: last ? last.created_at : otherAccount.created_at || new Date().toISOString(),
  };
}

// ------------------------------------------------ Native Direct Messages / Pleroma Chats API
bridgeRouter.get(['/api/v1/pleroma/chats', '/api/v2/pleroma/chats'], requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const dmsRes = await query(
    'SELECT * FROM direct_messages WHERE sender_did = $1 OR recipient_did = $1 ORDER BY created_at DESC',
    [currentDid]
  );
  const dms = dmsRes.rows || [];
  const otherDids = new Set(dms.map((m) => (m.sender_did === currentDid ? m.recipient_did : m.sender_did)));

  const chats = [];
  for (const did of otherDids) {
    const acc = await getAccountByDidOrHandle(did);
    if (acc) {
      chats.push(await buildChatSummary(acc, currentDid));
    }
  }

  chats.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  res.json(chats);
});

bridgeRouter.get('/api/v1/pleroma/chats/:id', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.id);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });
  const chat = await buildChatSummary(otherAcc, currentDid);
  res.json(chat);
});

bridgeRouter.post('/api/v1/pleroma/chats/by-account-id/:accountId', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.accountId);
  if (!otherAcc) return res.status(404).json({ error: 'Account not found' });
  const chat = await buildChatSummary(otherAcc, currentDid);
  res.json(chat);
});

bridgeRouter.get('/api/v1/pleroma/chats/:id/messages', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.id);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  const resMsgs = await query(
    'SELECT * FROM direct_messages WHERE (sender_did = $1 AND recipient_did = $2) OR (sender_did = $2 AND recipient_did = $1) ORDER BY created_at DESC',
    [currentDid, otherAcc.did]
  );
  const messages = (resMsgs.rows || []).map((m) => dmToChatMessage(m, otherAcc.did));
  res.json(messages);
});

bridgeRouter.post('/api/v1/pleroma/chats/:id/messages', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.id);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  const text = String(req.body.content || req.body.text || '').trim();
  const mediaUrl = req.body.media_id ? (mediaUploads.get(req.body.media_id)?.url || null) : null;
  if (!text && !mediaUrl) return res.status(400).json({ error: 'Message cannot be empty' });

  const insertRes = await query(
    'INSERT INTO direct_messages (sender_did, recipient_did, ciphertext, media_url, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
    [currentDid, otherAcc.did, text, mediaUrl]
  );
  const m = insertRes.rows[0];
  const chatMessage = dmToChatMessage(m, otherAcc.did);

  // Send real-time updates via streaming server if active
  if (global.__z3BroadcastChatUpdate) {
    global.__z3BroadcastChatUpdate(currentDid, otherAcc.did, await buildChatSummary(otherAcc, currentDid), await buildChatSummary(req.user, otherAcc.did));
  }

  res.json(chatMessage);
});

bridgeRouter.post('/api/v1/pleroma/chats/:id/read', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.id);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  await query(
    'UPDATE direct_messages SET read_at = NOW() WHERE sender_did = $1 AND recipient_did = $2 AND read_at IS NULL',
    [otherAcc.did, currentDid]
  );

  const chat = await buildChatSummary(otherAcc, currentDid);
  res.json(chat);
});

bridgeRouter.delete('/api/v1/pleroma/chats/:id/messages/:messageId', requireAuth, async (req, res) => {
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(req.params.id);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  const delRes = await query(
    'DELETE FROM direct_messages WHERE id = $1 AND sender_did = $2 RETURNING id',
    [req.params.messageId, currentDid]
  );
  if (!delRes.rows.length) return res.status(404).json({ error: 'Message not found or not owned by you' });

  res.json({ id: req.params.messageId, chat_id: otherAcc.did });
});

// Direct Messages Emoji Reactions Endpoint (exclusive to Direct Messages!)
bridgeRouter.put('/api/v1/pleroma/chats/:chatId/messages/:messageId/reactions/:emoji', requireAuth, async (req, res) => {
  const { chatId, messageId, emoji } = req.params;
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(chatId);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  const msgRes = await query('SELECT * FROM direct_messages WHERE id = $1', [messageId]);
  if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = msgRes.rows[0];

  msg.reactions = msg.reactions || {};
  if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
  if (!msg.reactions[emoji].includes(currentDid)) {
    msg.reactions[emoji].push(currentDid);
  }

  await query('UPDATE direct_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(msg.reactions), messageId]);

  res.json(dmToChatMessage(msg, otherAcc.did));
});

bridgeRouter.delete('/api/v1/pleroma/chats/:chatId/messages/:messageId/reactions/:emoji', requireAuth, async (req, res) => {
  const { chatId, messageId, emoji } = req.params;
  const currentDid = req.user.did;
  const otherAcc = await getAccountByDidOrHandle(chatId);
  if (!otherAcc) return res.status(404).json({ error: 'Chat not found' });

  const msgRes = await query('SELECT * FROM direct_messages WHERE id = $1', [messageId]);
  if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = msgRes.rows[0];

  msg.reactions = msg.reactions || {};
  if (Array.isArray(msg.reactions[emoji])) {
    msg.reactions[emoji] = msg.reactions[emoji].filter((did) => did !== currentDid);
    if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
  }

  await query('UPDATE direct_messages SET reactions = $1 WHERE id = $2', [JSON.stringify(msg.reactions), messageId]);

  res.json(dmToChatMessage(msg, otherAcc.did));
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

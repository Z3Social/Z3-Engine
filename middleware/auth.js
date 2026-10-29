import crypto from 'node:crypto';
import { query } from '../config/db.js';
import { XRPCError } from '../lib/lex/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'z3_sovereign_secret_key_super_safe_and_lightweight';

/**
 * Creates a signed token payload: base64(payload).signature
 * Pure native crypto without dependencies
 * @param {object} payload
 * @returns {string}
 */
export function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 30 * 24 * 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  return `${header}.${data}.${signature}`;
}

/**
 * Verifies a token
 * @param {string} token
 * @returns {object|null}
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, data, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${data}`).digest('base64url');
  
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Middleware: extracts authenticated user DID and account if present
 */
export async function optionalAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.headers.cookie) {
      const match = req.headers.cookie.match(/z3sid=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      req.user = null;
      return next();
    }

    const payload = verifyToken(token);
    if (!payload || !payload.did) {
      req.user = null;
      return next();
    }

    const resDb = await query(
      'SELECT did, handle, email, display_name, avatar_url, banner_url, bio, is_private, created_at, deleted_at FROM accounts WHERE did = $1',
      [payload.did]
    );

    if (!resDb.rows.length || resDb.rows[0].deleted_at !== null) {
      req.user = null;
      return next();
    }

    req.user = resDb.rows[0];
    req.did = req.user.did;
    next();
  } catch (err) {
    console.error('[Auth Middleware Error]:', err.message);
    req.user = null;
    next();
  }
}

/**
 * Middleware: requires active authentication
 */
export async function requireAuth(req, res, next) {
  await optionalAuth(req, res, () => {
    if (!req.user) {
      return res.status(401).json(XRPCError.authRequired().toJSON());
    }
    next();
  });
}

export default {
  createToken,
  verifyToken,
  optionalAuth,
  requireAuth,
};

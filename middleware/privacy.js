import { query } from '../config/db.js';
import { XRPCError } from '../lib/lex/index.js';

/**
 * Access Control: Verifies if the requester is allowed to view target account's content
 * Tracker #6: Private Accounts
 * @param {string|null} requesterDid
 * @param {string} targetDid
 * @returns {Promise<boolean>}
 */
export async function canViewAccount(requesterDid, targetDid) {
  if (requesterDid === targetDid) return true;

  const res = await query('SELECT is_private, deleted_at FROM accounts WHERE did = $1', [targetDid]);
  if (!res.rows.length || res.rows[0].deleted_at !== null) {
    return false;
  }

  // Public accounts can be viewed by anyone
  if (!res.rows[0].is_private) return true;

  // Private account requires mutual follow / active follow record
  if (!requesterDid) return false;

  const followCheck = await query(
    `SELECT 1 FROM records 
     WHERE did = $1 AND collection = 'app.bsky.graph.follow' AND data->>'subject' = $2`,
    [requesterDid, targetDid]
  );

  return followCheck.rows.length > 0;
}

/**
 * Access Control: Verifies if requester is member of private follower circle (Tracker #10)
 * @param {string|null} requesterDid
 * @param {string} circleId
 * @returns {Promise<boolean>}
 */
export async function canAccessCircle(requesterDid, circleId) {
  if (!requesterDid || !circleId) return false;

  // Circle owner check
  const circleRes = await query('SELECT owner_did FROM circles WHERE id = $1', [circleId]);
  if (!circleRes.rows.length) return false;
  if (circleRes.rows[0].owner_did === requesterDid) return true;

  // Circle member check
  const memberRes = await query(
    'SELECT 1 FROM circle_members WHERE circle_id = $1 AND member_did = $2',
    [circleId, requesterDid]
  );

  return memberRes.rows.length > 0;
}

/**
 * Access Control: Verifies if requester can read a DM thread (Tracker #15)
 * @param {string} requesterDid
 * @param {string} senderDid
 * @param {string} recipientDid
 * @returns {boolean}
 */
export function canReadDirectMessage(requesterDid, senderDid, recipientDid) {
  return requesterDid === senderDid || requesterDid === recipientDid;
}

/**
 * Express middleware to protect private profile/records access
 */
export function enforceAccountPrivacy(paramName = 'repo') {
  return async (req, res, next) => {
    const target = req.params[paramName] || req.query[paramName] || req.body[paramName];
    if (!target) return next();

    try {
      let targetDid = target;
      if (!target.startsWith('did:')) {
        const accRes = await query('SELECT did FROM accounts WHERE handle = $1', [target]);
        if (!accRes.rows.length) {
          return res.status(404).json(XRPCError.notFound('Account not found').toJSON());
        }
        targetDid = accRes.rows[0].did;
      }

      const allowed = await canViewAccount(req.user ? req.user.did : null, targetDid);
      if (!allowed) {
        return res.status(403).json(XRPCError.forbidden('This account is private.').toJSON());
      }
      next();
    } catch (err) {
      console.error('[Privacy Middleware Error]:', err.message);
      res.status(500).json(XRPCError.invalidRequest('Error checking privacy status').toJSON());
    }
  };
}

export default {
  canViewAccount,
  canAccessCircle,
  canReadDirectMessage,
  enforceAccountPrivacy,
};

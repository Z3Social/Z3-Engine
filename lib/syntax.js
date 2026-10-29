/**
 * Sovereign Syntax and TID Generation
 * Crockford Base32 implementation for AT-Protocol TID strings and at:// URI parsing
 */

// Crockford Base32 alphabet (omits I, L, O, U to avoid ambiguity)
const CROCKFORD_CHARS = '23456789abcdefghjkmnpqrstvwxyz';

let lastTimestamp = 0;
let clockSeq = 0;

/**
 * Encodes an integer/BigInt into Crockford Base32
 * @param {bigint|number} num
 * @param {number} padLength
 * @returns {string}
 */
export function encodeBase32(num, padLength = 0) {
  let val = BigInt(num);
  if (val === 0n) {
    return '2'.repeat(padLength || 1);
  }
  let str = '';
  const base = 32n;
  while (val > 0n) {
    const rem = Number(val % base);
    str = CROCKFORD_CHARS[rem] + str;
    val = val / base;
  }
  if (padLength > str.length) {
    str = '2'.repeat(padLength - str.length) + str;
  }
  return str;
}

/**
 * Generates a standard 13-character Crockford Base32 TID (Timestamp Identifier)
 * Uses 64-bit: 54-bit timestamp in microseconds + 10-bit clock sequence
 * @returns {string} e.g. "3jui2abcde234"
 */
export function generateTID() {
  let nowMicros = BigInt(Date.now()) * 1000n;
  const nowMs = Number(nowMicros / 1000n);

  if (nowMs === lastTimestamp) {
    clockSeq = (clockSeq + 1) & 0x3ff; // 10 bits (0-1023)
  } else {
    lastTimestamp = nowMs;
    clockSeq = Math.floor(Math.random() * 0x3ff);
  }

  // Combine timestamp (high bits) and clock sequence (low 10 bits)
  const tidNum = (nowMicros << 10n) | BigInt(clockSeq);
  return encodeBase32(tidNum, 13);
}

/**
 * Parses an at:// URI into components
 * format: at://<did-or-handle>/<collection>/<rkey>
 * @param {string} uri
 * @returns {{ repo: string, collection?: string, rkey?: string }}
 */
export function parseAtUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('at://')) {
    throw new Error(`Invalid AT-URI: "${uri}". Must begin with at://`);
  }

  const parts = uri.slice(5).split('/');
  const repo = parts[0];
  const collection = parts[1] || undefined;
  const rkey = parts[2] || undefined;

  return { repo, collection, rkey };
}

/**
 * Formats components into an at:// URI
 * @param {string} repo - DID or handle
 * @param {string} collection - NSID
 * @param {string} rkey - Record key
 * @returns {string}
 */
export function formatAtUri(repo, collection, rkey) {
  return `at://${repo}/${collection}/${rkey}`;
}

export default {
  generateTID,
  parseAtUri,
  formatAtUri,
  encodeBase32,
};

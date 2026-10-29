import crypto from 'node:crypto';

/**
 * Generates an Ed25519 keypair for sovereign DID signing
 * @returns {{ publicKey: string, privateKey: string }} PEM strings
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Signs data using an Ed25519 private key
 * @param {string|Buffer} data
 * @param {string} privateKeyPem
 * @returns {string} base64 signature
 */
export function sign(data, privateKeyPem) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const signature = crypto.sign(null, buf, privateKeyPem);
  return signature.toString('base64');
}

/**
 * Verifies an Ed25519 signature
 * @param {string|Buffer} data
 * @param {string} signatureBase64
 * @param {string} publicKeyPem
 * @returns {boolean}
 */
export function verify(data, signatureBase64, publicKeyPem) {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const sigBuf = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, buf, publicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Computes deterministic SHA-256 hash for records
 * @param {any} val
 * @returns {string} hex hash
 */
export function sha256(val) {
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Password hashing using native scrypt
 * @param {string} password
 * @returns {Promise<string>} salt:hash format
 */
export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verifies a password against scrypt salt:hash
 * @param {string} password
 * @param {string} storedHash
 * @returns {Promise<boolean>}
 */
export function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    if (!storedHash || !storedHash.includes(':')) return resolve(false);
    const [salt, key] = storedHash.split(':');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      const keyBuffer = Buffer.from(key, 'hex');
      resolve(crypto.timingSafeEqual(derivedKey, keyBuffer));
    });
  });
}

export default {
  generateKeyPair,
  sign,
  verify,
  sha256,
  hashPassword,
  verifyPassword,
};

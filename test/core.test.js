import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTID, parseAtUri, formatAtUri } from '../lib/syntax.js';
import { hashPassword, verifyPassword, generateKeyPair, sign, verify } from '../lib/crypto.js';
import { LexiconStore } from '../lib/lex/store.js';
import { assertValidRecord, XRPCError } from '../lib/lex/index.js';
import { createToken, verifyToken } from '../middleware/auth.js';

test('1. Syntax & TID Generator', () => {
  const tid1 = generateTID();
  const tid2 = generateTID();
  assert.equal(typeof tid1, 'string');
  assert.equal(tid1.length >= 13, true);
  assert.notEqual(tid1, tid2);

  const parsed = parseAtUri('at://did:z3:alice/app.bsky.feed.post/3jui123');
  assert.equal(parsed.repo, 'did:z3:alice');
  assert.equal(parsed.collection, 'app.bsky.feed.post');
  assert.equal(parsed.rkey, '3jui123');

  const formatted = formatAtUri('did:z3:bob', 'org.z3social.group', 'g1');
  assert.equal(formatted, 'at://did:z3:bob/org.z3social.group/g1');
});

test('2. Cryptography & Ed25519 Signatures', async () => {
  const { publicKey, privateKey } = generateKeyPair();
  const data = 'sovereign-payload';
  const signature = sign(data, privateKey);
  assert.equal(verify(data, signature, publicKey), true);
  assert.equal(verify('tampered-payload', signature, publicKey), false);

  const pwd = 'secretPassword123';
  const hashed = await hashPassword(pwd);
  assert.equal(await verifyPassword(pwd, hashed), true);
  assert.equal(await verifyPassword('wrong', hashed), false);
});

test('3. Lexicon Validation Engine', () => {
  // Valid post
  assertValidRecord('app.bsky.feed.post', {
    text: 'Hello Z3!',
    createdAt: new Date().toISOString(),
  });

  // Invalid post (missing text)
  assert.throws(() => {
    assertValidRecord('app.bsky.feed.post', {
      createdAt: new Date().toISOString(),
    });
  }, XRPCError);

  // Invalid post (text exceeds max length)
  assert.throws(() => {
    assertValidRecord('app.bsky.feed.post', {
      text: 'a'.repeat(6000),
      createdAt: new Date().toISOString(),
    });
  }, XRPCError);
});

test('4. Native Token Authentication', () => {
  const token = createToken({ did: 'did:z3:testuser', handle: 'testuser' });
  const payload = verifyToken(token);
  assert.equal(payload.did, 'did:z3:testuser');
  assert.equal(payload.handle, 'testuser');

  assert.equal(verifyToken(token + 'tamper'), null);
});

test('5. Custom Sovereign Lexicon (org.z3social.group & circle)', () => {
  // Valid group record
  assertValidRecord('org.z3social.group', {
    name: 'Ivan Music',
    description: 'Community for musicians',
    privacy: 'public',
    createdAt: new Date().toISOString(),
  });

  // Invalid group (missing name)
  assert.throws(() => {
    assertValidRecord('org.z3social.group', {
      description: 'Community without name',
    });
  }, XRPCError);

  // Valid circle record
  assertValidRecord('org.z3social.circle', {
    name: 'Close Friends',
    isPrivate: true,
    createdAt: new Date().toISOString(),
  });
});

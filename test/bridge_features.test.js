import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { bridgeRouter } from '../routes/bridge.js';
import { query } from '../config/db.js';
import { createToken } from '../middleware/auth.js';

test('Bridge API Comprehensive Test Suite', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(bridgeRouter);

  const testToken = createToken({ did: 'did:z3:ivanalbrieu', handle: 'ivanalbrieu' });

  // 1. Thread context test
  await t.test('1. GET /api/v1/statuses/:id/context resolves ancestors and descendants', async () => {
    // b9a0024d is a reply to 16bc08a5, and 86358512 is a reply to b9a0024d
    const server = app.listen(0);
    const port = server.address().port;

    const res = await fetch(`http://localhost:${port}/api/v1/statuses/b9a0024d-8b40-479d-be12-ba26afcd80bf/context`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert(Array.isArray(data.ancestors), 'ancestors should be an array');
    assert(Array.isArray(data.descendants), 'descendants should be an array');
    assert.equal(data.ancestors.length, 1, 'should have 1 ancestor (16bc08a5...)');
    assert.equal(data.ancestors[0].id, '16bc08a5-2fb8-4d7e-8bd1-c5115867741b');
    assert.equal(data.descendants.length, 1, 'should have 1 descendant (86358512...)');
    assert.equal(data.descendants[0].id, '86358512-84b5-4366-a89b-d0328833e17a');

    server.close();
  });

  // 2. Favourite & unfavourite test
  await t.test('2. POST /api/v1/statuses/:id/favourite and unfavourite', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    // Favourite
    const favRes = await fetch(`http://localhost:${port}/api/v1/statuses/3681593f-65ea-41f9-b16e-7029313a1937/favourite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(favRes.status, 200);
    const favData = await favRes.json();
    assert.equal(favData.favourited, true);
    assert(favData.favourites_count >= 1);

    // Unfavourite
    const unfavRes = await fetch(`http://localhost:${port}/api/v1/statuses/3681593f-65ea-41f9-b16e-7029313a1937/unfavourite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(unfavRes.status, 200);
    const unfavData = await unfavRes.json();
    assert.equal(unfavData.favourited, false);

    server.close();
  });

  // 3. Reblog & unreblog test
  await t.test('3. POST /api/v1/statuses/:id/reblog and unreblog', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    // Reblog
    const rebRes = await fetch(`http://localhost:${port}/api/v1/statuses/3681593f-65ea-41f9-b16e-7029313a1937/reblog`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(rebRes.status, 200);
    const rebData = await rebRes.json();
    assert(rebData.reblog !== null, 'Reblog wrapper must include reblog target');
    assert.equal(rebData.reblog.id, '3681593f-65ea-41f9-b16e-7029313a1937');

    // Unreblog
    const unrebRes = await fetch(`http://localhost:${port}/api/v1/statuses/3681593f-65ea-41f9-b16e-7029313a1937/unreblog`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(unrebRes.status, 200);
    const unrebData = await unrebRes.json();
    assert.equal(unrebData.reblogged, false);

    server.close();
  });

  // 4. Group metadata lookup in status
  await t.test('4. Group lookup returns group title instead of raw UUID', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    const res = await fetch(`http://localhost:${port}/api/v1/statuses/b4051201-5937-441e-a7f2-e6fb47525075`);
    assert.equal(res.status, 200);
    const post = await res.json();
    assert(post.group !== null, 'post should have group metadata');
    assert.equal(post.group.id, 'da46cc43-97a6-4514-9233-c0ee3a79c1fa');
    assert.equal(post.group.title, 'Ivan Music', 'Group title must be human readable name');
    assert.equal(post.group.slug, 'ivan-music');

    server.close();
  });

  // 5. Group feed filtering
  await t.test('5. Home timeline filters group posts based on membership', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    // ivanalbrieu is in Ivan Music (da46cc43...) and Rouxls Kaard (41c4088a...)
    const resAuth = await fetch(`http://localhost:${port}/api/v1/timelines/home`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(resAuth.status, 200);
    const postsAuth = await resAuth.json();
    assert(postsAuth.length > 0);
    // Should have post b4051201 (posted in Ivan Music)
    assert(postsAuth.some((p) => p.id === 'b4051201-5937-441e-a7f2-e6fb47525075'));

    // Anonymous or unjoined user should NOT see private unjoined group posts
    const resAnon = await fetch(`http://localhost:${port}/api/v1/timelines/home`);
    const postsAnon = await resAnon.json();
    assert(!postsAnon.some((p) => p.group && p.group.id === 'da46cc43-97a6-4514-9233-c0ee3a79c1fa'), 'Anonymous user must not see group posts in home feed');

    server.close();
  });

  // 6. Profile editing & credentials update
  await t.test('6. PATCH /api/v1/accounts/update_credentials updates bio and returns valid source', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    const res = await fetch(`http://localhost:${port}/api/v1/accounts/update_credentials`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        note: 'Updated sovereign test bio',
        display_name: 'Ivan A.',
      }),
    });
    assert.equal(res.status, 200);
    const acc = await res.json();
    assert(acc.source !== undefined);
    assert.equal(acc.source.note, 'Updated sovereign test bio');
    assert(Array.isArray(acc.source.fields), 'acc.source.fields must be an array');
    assert.equal(acc.display_name, 'Ivan A.');

    server.close();
  });

  // 7. Posts do NOT expose emoji reactions (exclusive to Direct Messages)
  await t.test('7. Posts do NOT expose emoji reactions in pleroma.emoji_reactions', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    const res = await fetch(`http://localhost:${port}/api/v1/statuses/3681593f-65ea-41f9-b16e-7029313a1937`);
    assert.equal(res.status, 200);
    const post = await res.json();
    assert.equal(post.id, '3681593f-65ea-41f9-b16e-7029313a1937');
    assert.deepEqual(post.pleroma.emoji_reactions, [], 'Post emoji_reactions must be empty array');
    assert.equal(typeof post.favourites_count, 'number', 'Post retains standard favourite count');

    server.close();
  });

  // 8. Direct Messages and DM Emoji Reactions (Wix/BSky Tab chat endpoints)
  await t.test('8. Direct Messages thread, sending, and emoji reactions', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    // Send a DM from ivanalbrieu to agusalbrieu
    const sendRes = await fetch(`http://localhost:${port}/api/v1/pleroma/chats/did:z3:agusalbrieu/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Hello from sovereign DM tab! ✨',
      }),
    });
    assert.equal(sendRes.status, 200);
    const sentMsg = await sendRes.json();
    assert.equal(sentMsg.account_id, 'did:z3:ivanalbrieu');
    assert.equal(sentMsg.content, 'Hello from sovereign DM tab! ✨');
    assert(sentMsg.id, 'Message should have an id');

    // React with emoji to the message (DM exclusive)
    const reactRes = await fetch(`http://localhost:${port}/api/v1/pleroma/chats/did:z3:agusalbrieu/messages/${sentMsg.id}/reactions/🔥`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(reactRes.status, 200);
    const reactedMsg = await reactRes.json();
    assert(reactedMsg.emoji_reactions.some((r) => r.name === '🔥' && r.count === 1));

    // Fetch conversation list
    const chatsRes = await fetch(`http://localhost:${port}/api/v1/pleroma/chats`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(chatsRes.status, 200);
    const chats = await chatsRes.json();
    assert(chats.some((c) => c.account.username === 'agusalbrieu'));

    // Mark chat as read
    const readRes = await fetch(`http://localhost:${port}/api/v1/pleroma/chats/did:z3:agusalbrieu/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(readRes.status, 200);

    server.close();
  });
});

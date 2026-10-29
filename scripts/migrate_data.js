import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const oldDbFile = 'D:/dev/Z3 Social/Z3-Backend/data/db.json';
const oldDb = JSON.parse(fs.readFileSync(oldDbFile, 'utf8'));

const accounts = oldDb.users.map((u) => ({
  did: `did:z3:${u.username}`,
  handle: u.username,
  email: u.email,
  password_hash: `${u.salt}:${u.passHash}`,
  public_key: null,
  is_private: !!u.locked,
  display_name: u.displayName || u.username,
  avatar_url: u.avatar || '/media/logo.png',
  banner_url: u.cover || '/media/z3-central-cover.jpg',
  bio: u.bio || '',
  fields: u.website ? [{ name: 'Website', value: u.website }] : [],
  is_admin: u.role === 'owner' || u.role === 'admin',
  created_at: u.createdAt || new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
}));

// Also ensure 'password' works for quick dev login if user forgot
// We'll also allow 'z3admin' and 'password'

const records = oldDb.posts.map((p, idx) => ({
  id: idx + 1,
  did: p.authorId === '6aa0c37b-9344-4484-81d3-1707bbaa1a25' ? 'did:z3:ivanalbrieu' : 'did:z3:agusalbrieu',
  collection: 'app.bsky.feed.post',
  rkey: p.id,
  data: {
    text: p.text || p.content || '',
    createdAt: p.createdAt,
    editedAt: p.editedAt || undefined,
    group: p.groupId || undefined,
    media: p.media || [],
  },
  created_at: p.createdAt,
  updated_at: p.editedAt || p.createdAt,
}));

const sovereign = {
  accounts,
  records,
  circles: [],
  circle_members: [],
  direct_messages: [],
};

const targetFile = 'D:/dev/Z3 Social/Z3-Engine/data/sovereign.json';
fs.mkdirSync(path.dirname(targetFile), { recursive: true });
fs.writeFileSync(targetFile, JSON.stringify(sovereign, null, 2), 'utf8');
console.log('Successfully wrote sovereign.json with', accounts.length, 'accounts and', records.length, 'records.');

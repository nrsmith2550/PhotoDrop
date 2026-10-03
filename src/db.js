import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';

fs.mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/photodrop.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    stripe_session_id TEXT UNIQUE NOT NULL,
    email TEXT,
    slug TEXT UNIQUE NOT NULL,
    folder_name TEXT,
    folder_id TEXT,
    refresh_token_enc TEXT,
    session_token TEXT UNIQUE NOT NULL,
    upload_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

export function createAccountFromPayment({ stripeSessionId, email }) {
  const existing = getByStripeSession(stripeSessionId);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO accounts (id, stripe_session_id, email, slug, session_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId(8), stripeSessionId, email ?? null, newId(6), newId(24), Date.now());
  return getByStripeSession(stripeSessionId);
}

function getByStripeSession(id) {
  return db.prepare('SELECT * FROM accounts WHERE stripe_session_id = ?').get(id);
}
export const getBySessionToken = (t) =>
  t ? db.prepare('SELECT * FROM accounts WHERE session_token = ?').get(t) : undefined;
export const getBySlug = (s) => db.prepare('SELECT * FROM accounts WHERE slug = ?').get(s);

export function saveDriveLink(id, { folderName, folderId, refreshTokenEnc }) {
  db.prepare(
    'UPDATE accounts SET folder_name = ?, folder_id = ?, refresh_token_enc = ? WHERE id = ?'
  ).run(folderName, folderId, refreshTokenEnc, id);
}
export function bumpUploads(id, n) {
  db.prepare('UPDATE accounts SET upload_count = upload_count + ? WHERE id = ?').run(n, id);
}

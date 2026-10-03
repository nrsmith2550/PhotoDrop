import crypto from 'node:crypto';

const key = () => {
  if (!process.env.SECRET_KEY || process.env.SECRET_KEY.length < 32)
    throw new Error('SECRET_KEY must be set (32+ chars)');
  return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
};

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Signed, expiring value for the OAuth `state` param (CSRF protection).
export function sign(obj, ttlMs = 10 * 60 * 1000) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token) {
  const [body, sig] = (token ?? '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
  return obj.exp > Date.now() ? obj : null;
}

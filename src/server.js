import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import Stripe from 'stripe';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './db.js';
import { encrypt, decrypt, sign, verify } from './crypto.js';
import { authUrl, oauthClient, createFolder, uploadFile } from './drive.js';
import { page, esc } from './views.js';

const { BASE_URL, PRICE_CENTS = '1000', STRIPE_WEBHOOK_SECRET } = process.env;
for (const k of ['BASE_URL', 'STRIPE_SECRET_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SECRET_KEY'])
  if (!process.env[k]) throw new Error(`Missing env var ${k} (see .env.example)`);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_MB = 25;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 20 } });
const IMAGE_OR_VIDEO = /^(image|video)\//;
const secureCookie = BASE_URL.startsWith('https');

function login(res, account) {
  res.cookie('pd_session', account.session_token, {
    httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: 365 * 24 * 3600 * 1000,
  });
}
const currentAccount = (req) => store.getBySessionToken(req.cookies.pd_session);

// --- Stripe webhook (raw body; must be registered before express.json) ---
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.sendStatus(404);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    store.createAccountFromPayment({
      stripeSessionId: event.data.object.id,
      email: event.data.object.customer_details?.email,
    });
  }
  res.sendStatus(200);
});

app.use(cookieParser());
app.use(express.static(path.join(here, '..', 'public')));

// --- 1. Pay ---
app.post('/checkout', async (_req, res, next) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Number(PRICE_CENTS),
          product_data: { name: 'PhotoDrop – lifetime access', description: 'Collect photos straight into your own Google Drive.' },
        },
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/`,
    });
    res.redirect(303, session.url);
  } catch (e) { next(e); }
});

// Verify payment on return (works even if the webhook hasn't fired yet), then log in.
app.get('/success', async (req, res, next) => {
  try {
    const s = await stripe.checkout.sessions.retrieve(String(req.query.session_id ?? ''));
    if (s.payment_status !== 'paid') return res.redirect('/');
    const account = store.createAccountFromPayment({ stripeSessionId: s.id, email: s.customer_details?.email });
    login(res, account);
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

// --- 2. Link Drive + name folder ---
app.get('/dashboard', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.redirect('/');
  const link = `${BASE_URL}/u/${account.slug}`;
  const body = account.folder_id
    ? `<h1>You're all set 🎉</h1>
       <p>Photos uploaded through your link land in the <b>${esc(account.folder_name)}</b> folder in your Google Drive.</p>
       <label>Share this link with your guests</label>
       <input readonly value="${esc(link)}" onclick="this.select()">
       <p><a class="btn" href="/u/${account.slug}">Open upload page</a></p>
       <p class="muted">${account.upload_count} file(s) uploaded so far.</p>`
    : `<h1>Link your Google Drive</h1>
       <p>Pick a name for the folder we'll create in your Drive. We can only see files and folders PhotoDrop creates — nothing else.</p>
       <form action="/auth/google" method="get">
         <label for="folder">Folder name</label>
         <input id="folder" name="folder" maxlength="100" required placeholder="e.g. Sarah &amp; Tom's Wedding">
         <button class="btn">Connect Google Drive</button>
       </form>`;
  res.send(page('Dashboard', body));
});

app.get('/auth/google', (req, res) => {
  const account = currentAccount(req);
  if (!account) return res.redirect('/');
  const folder = String(req.query.folder ?? '').trim().slice(0, 100);
  if (!folder) return res.redirect('/dashboard');
  res.redirect(authUrl(sign({ a: account.id, f: folder })));
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const account = currentAccount(req);
    const state = verify(String(req.query.state ?? ''));
    if (!account || !state || state.a !== account.id || req.query.error || !req.query.code)
      return res.status(400).send(page('Cancelled', '<h1>Drive link cancelled</h1><p><a href="/dashboard">Try again</a></p>'));
    const { tokens } = await oauthClient().getToken(String(req.query.code));
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
    const folderId = await createFolder(tokens.refresh_token, state.f);
    store.saveDriveLink(account.id, {
      folderName: state.f, folderId, refreshTokenEnc: encrypt(tokens.refresh_token),
    });
    res.redirect('/dashboard');
  } catch (e) { next(e); }
});

// --- 3. Public upload page for the customer's guests ---
app.get('/u/:slug', (req, res) => {
  const account = store.getBySlug(req.params.slug);
  if (!account?.folder_id) return res.status(404).send(page('Not found', '<h1>This upload page isn\'t active.</h1>'));
  res.send(page(`Upload to ${account.folder_name}`, `
    <h1>${esc(account.folder_name)}</h1>
    <p>Choose photos or videos to add (up to ${MAX_MB} MB each).</p>
    <form id="f"><input type="file" name="files" accept="image/*,video/*" multiple required>
    <button class="btn">Upload</button></form>
    <p id="msg" class="muted"></p>
    <script>
      const f = document.getElementById('f'), msg = document.getElementById('msg');
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); msg.textContent = 'Uploading…';
        const r = await fetch('/u/${account.slug}/upload', { method: 'POST', body: new FormData(f) });
        const j = await r.json().catch(() => ({}));
        msg.textContent = r.ok ? '✅ Uploaded ' + j.uploaded + ' file(s). Thank you!' : '❌ ' + (j.error || 'Upload failed');
        if (r.ok) f.reset();
      });
    </script>`));
});

app.post('/u/:slug/upload', upload.array('files', 20), async (req, res) => {
  const account = store.getBySlug(req.params.slug);
  if (!account?.folder_id) return res.status(404).json({ error: 'Not found' });
  const files = (req.files ?? []).filter((f) => IMAGE_OR_VIDEO.test(f.mimetype));
  if (!files.length) return res.status(400).json({ error: 'Please choose image or video files.' });
  try {
    const token = decrypt(account.refresh_token_enc);
    for (const f of files)
      await uploadFile(token, account.folder_id, { name: f.originalname, mimeType: f.mimetype, buffer: f.buffer });
    store.bumpUploads(account.id, files.length);
    res.json({ uploaded: files.length });
  } catch (e) {
    console.error('upload failed', e.message);
    res.status(502).json({ error: 'Could not save to Google Drive. Please try again.' });
  }
});

// Multer limit errors etc.
app.use((err, _req, res, _next) => {
  console.error(err);
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 500);
  const msg = tooBig ? `Files must be under ${MAX_MB} MB.` : 'Something went wrong.';
  res.format({ json: () => res.json({ error: msg }), default: () => res.send(page('Error', `<h1>${msg}</h1>`)) });
});

app.listen(process.env.PORT ?? 3000, () => console.log(`PhotoDrop running at ${BASE_URL}`));

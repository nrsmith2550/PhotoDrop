# PhotoDrop

Customers pay a flat $10 (Stripe Checkout), connect **their own** Google Drive (OAuth, `drive.file` scope), pick a folder name, and get a public upload link to share. Uploads go straight into that folder in their Drive.

## Setup
1. `cp .env.example .env` and fill it in (Stripe keys, Google OAuth client, `SECRET_KEY`).
2. Google Cloud: enable the Drive API, create a Web OAuth client with redirect URI `${BASE_URL}/auth/google/callback`. For public use, publish the consent screen (`drive.file` is non-sensitive, so no heavy verification).
3. Stripe: optionally add a webhook to `${BASE_URL}/stripe/webhook` for `checkout.session.completed`.
4. `npm install && npm start` (Node 22.13+).

## Flow
`/` → `POST /checkout` → Stripe → `/success` (verifies payment, logs in) → `/dashboard` (name folder, connect Drive) → share `/u/<slug>`.

Refresh tokens are AES-256-GCM encrypted in `data/photodrop.db` (SQLite).

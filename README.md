# DW Web Solutions

A Node.js/Express backend with a private admin media-management dashboard,
serving the public marketing site from `public/`.

## Stack

- **Server:** Node.js + Express 5
- **Database:** SQLite via `better-sqlite3` (file at `data/app.db`, auto-created)
- **Sessions:** server-side sessions stored in the same SQLite DB (custom store, no Redis needed)
- **Media storage:** local filesystem under `uploads/` (originals, optimized, thumbnails)
- **Image processing:** `sharp` (resize/compress/strip metadata) + DOMPurify for SVG sanitization
- **Video processing:** bundled `ffmpeg`/`ffprobe` binaries for thumbnails, duration, and format validation

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
# generate a random session secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# generate your admin password hash
npm run hash-password -- "YourStrongPassword"
```

Paste the results into `SESSION_SECRET` and `ADMIN_PASSWORD_HASH` in `.env`,
and set `ADMIN_USERNAME`.

Run it:

```bash
npm start          # production
npm run dev        # development (NODE_ENV=development)
```

- Public site: `http://localhost:3000/`
- Admin dashboard: `http://localhost:3000/admin` (redirects to login if not authenticated)

## How media reaches the public site

Any element in `public/index.html` carrying `data-slot="some.key"` is filled
in at page-load by `public/js/media-slots.js`, which calls the public,
unauthenticated `GET /api/media/public` endpoint. Assigning a slot key to an
uploaded file in the admin dashboard ("Publish" button) makes it appear on
the live site immediately, with zero code changes. Currently wired slots:
`hero.background`, `work.plate-01`, `work.plate-02`, `work.plate-03` — add
more by adding `data-slot="..."` to any element (images decorate `<img>`
tags directly; anything else gets an absolutely-positioned image/video
layer injected behind its content).

## Contact form

The site's contact form posts to `POST /api/contact`, which validates the
input, saves every submission to the `contact_messages` table (visible in
the admin dashboard's "Messages" tab, with an unread-count badge), and —
only if SMTP is configured — also sends an email notification. Leads are
never lost even without email set up. Protected by rate limiting (5
submissions per 15 minutes per IP) and a honeypot field.

To enable email notifications, set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
(and optionally `SMTP_PORT`, `SMTP_SECURE`, `CONTACT_TO_EMAIL`,
`CONTACT_FROM_EMAIL`) in `.env` — see `.env.example` for a Gmail App
Password example. Leave them blank to skip email and just use the admin
inbox.

## Security notes

- Uploaded files are verified by magic-byte sniffing (`file-type`), not by
  trusting the client's declared MIME type or extension.
- SVGs are sanitized (scripts/event handlers stripped) before being stored.
- Files are stored under randomized names; the admin API is the only thing
  that maps a display name back to a file.
- Admin routes require an authenticated session (bcrypt-hashed single-admin
  credentials from `.env`); state-changing requests also require a custom
  header the browser won't attach cross-site, as CSRF mitigation.
- Login attempts are rate-limited.

## Extending this later

The `media` table and `/api/media` routes are intentionally the only
content type implemented so far. Products, services, pages, blog posts,
testimonials, portfolio entries, pricing, banners, and SEO settings can each
follow the same pattern: a table in `server/db.js`, a router in
`server/routes/`, and a section in the admin sidebar (already stubbed as
"coming soon" in `server/admin-ui/index.html`) — all can reference existing
uploaded media by id rather than re-implementing upload handling.

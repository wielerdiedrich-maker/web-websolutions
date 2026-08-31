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

## Contact form

The public site's contact form posts to the public `POST /api/contact`
endpoint, which validates and stores the submission in the `contact_messages`
table (rate-limited to 10 submissions per 15 minutes per IP). Submissions are
reviewed at `/admin/messages` — mark as read, reply by email, or delete.

Business contact info (phone `519-613-6345`, email `wielerdiedrich@gmail.com`)
is wired into the header, footer, contact section, and a `LocalBusiness`
JSON-LD block in `public/index.html`.

## Extending this later

Products, services, pages, blog posts, testimonials, portfolio entries,
pricing, and SEO settings can each follow the same pattern as `media` and
`contact_messages`: a table in `server/db.js`, a router in `server/routes/`,
and a section in the admin sidebar (already stubbed as "coming soon" in
`server/admin-ui/index.html`) — all can reference existing uploaded media by
id rather than re-implementing upload handling.

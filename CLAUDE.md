# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js/Express backend serving a public marketing site (`public/`) plus a
private admin dashboard for media management and an embeddable AI-assisted
lead-capture system ("DW Lead Machine"). Single-tenant, no build step —
plain CommonJS run directly by Node.

## Commands

```bash
npm install
cp .env.example .env             # then fill in SESSION_SECRET + ADMIN_PASSWORD_HASH at minimum

# generate a session secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# generate the admin password hash
npm run hash-password -- "YourStrongPassword"

npm start                        # production
npm run dev                      # development (NODE_ENV=development)
```

- Public site: `http://localhost:3000/` — Admin dashboard: `http://localhost:3000/admin`
- **No test suite and no lint/format config exist in this repo.** There's a leftover
  `.github/workflows/npm-publish-github-packages.yml` that runs `npm test` on release
  creation, but no `test` script is defined in `package.json` — it would currently fail
  if triggered. Don't assume `npm test` works, and don't invent a testing setup unless asked.
- The SQLite file (`data/app.db`) is created automatically on first run (`server/db.js`);
  it's gitignored. Deleting it resets all data.

## Architecture

### Request flow (`server/index.js`)

One Express app wires everything: `helmet` → JSON/urlencoded body parsing → session
(custom SQLite-backed store) → a global rate limiter on `/api/*` → feature routers →
`/uploads` static (public, gated to no directory listing/script execution) → admin UI →
public site static fallback. The error-handling middleware at the bottom translates
`multer.MulterError` and the app's own `ValidationError` into 400s; everything else is a 500.

Two things are deliberate, not accidental, and matter when adding routes:
- **Admin UI is not a blanket static mount.** Each `/admin/*` HTML page is an explicit
  `app.get(..., requireAuth, ...)` in `index.js` pointing at `server/admin-ui/`. A new
  admin page needs its own explicit gated route — never add a `express.static` mount over
  `admin-ui/` or the dashboard becomes reachable without auth.
- **Auth + CSRF are applied per-router, not globally.** `requireAuth` (session check) and
  `requireSameOriginHeader` (state-changing requests must carry `X-Requested-With:
  DWWebAdmin`, which cross-site requests can't set) are imported from `server/auth.js` and
  applied explicitly inside each router — e.g. in `routes/media.js` and `routes/leads.js`
  the public `GET` routes are declared *before* `router.use(requireAuth)`, so route order
  within a file determines what's public.

### Data layer (`server/db.js`)

Single `better-sqlite3` connection, WAL mode, synchronous API (no async/await needed for
queries). Schema is plain `CREATE TABLE IF NOT EXISTS` executed at require-time — **there
is no migration framework**. Adding a column to an existing table requires either a manual
`ALTER TABLE` (add it yourself, `IF NOT EXISTS` won't retrofit existing DBs) or deleting
`data/app.db` in dev. Sessions live in their own table in the same DB (`sqliteSessionStore.js`
implements the `express-session` Store interface), not in a separate store like Redis.

### Media pipeline (`server/mediaProcessor.js`)

The single chokepoint every upload passes through — both the admin media library
(`routes/media.js`) and lead-form file attachments (`routes/leads.js`) call the same
`processUpload()`. It never trusts the client's declared MIME type/extension: it sniffs
real file contents via `file-type` (magic bytes), then branches:
- **Images** → `sharp`: strips EXIF/auto-orients, produces an optimized variant (resized,
  re-encoded) and a thumbnail. Originals, optimized, and thumbs are separate files under
  `uploads/{originals,optimized,thumbs}/` with randomized names (`crypto.randomBytes`).
- **Video** → bundled `ffmpeg`/`ffprobe` binaries (`@ffmpeg-installer`/`@ffprobe-installer`,
  no system install needed) for probing duration/dimensions and generating a thumbnail frame.
- **SVG** → sanitized via `DOMPurify` + `jsdom` (strips `<script>`, event handlers,
  `foreignObject`) before being stored as-is; no raster thumbnail is generated.

`file-type` is ESM-only — it's loaded via a memoized dynamic `import()` from this CommonJS
module (`getFileTypeFromFile()`). Follow that pattern rather than converting the module to ESM.

Every `media` row can optionally hold a `slot_key`. Lead-form attachments reuse the same
`media` table (tagged `folder = 'leads'`) linked via the `lead_files` join table, not a
separate storage path.

### Content "slots": how admin uploads reach the static marketing site

`public/index.html` is hand-written static HTML. Any element with `data-slot="some.key"`
gets hydrated at page-load by `public/js/media-slots.js`, which calls the public,
unauthenticated `GET /api/media/public` (returns only media rows with a non-null
`slot_key`). Assigning a slot to an uploaded file in the admin dashboard makes it appear
live with zero code changes — `<img>` tags get their `src` swapped; any other element gets
an absolutely-positioned image/video layer injected behind its content. This indirection is
the main way "backend content" and "static frontend" connect — when working on the public
site's dynamic content, start here rather than looking for a templating engine (there isn't
one).

### DW Lead Machine (lead capture → AI qualification → follow-up)

An embeddable, dependency-free widget (`public/js/lead-form.js`, namespaced `dwlm-`) posts
`multipart/form-data` to `POST /api/leads` from any page (see `public/dw-laser.html` for the
reference embed). From there, one request does a lot synchronously, in this order:

1. Validate + insert the `leads` row, log a `form_submitted` event.
2. Process any attached files through the shared media pipeline, link via `lead_files`.
3. Call `services/aiQualify.js`: OpenAI (JSON mode, a system prompt that explicitly forbids
   inventing pricing/availability/guarantees) if `OPENAI_API_KEY` is set, otherwise a
   transparent rule-based classifier — **the fallback always runs on error too**, so a bad
   OpenAI response never breaks lead submission. The engine used is stored on the lead
   (`ai_engine`) and shown in the dashboard, so results are never presented as AI-derived
   when they weren't.
4. Send the customer confirmation and owner-notification emails via `services/email.js`,
   which no-ops to a logged `{sent: false, reason: 'not_configured'}` rather than throwing
   when SMTP env vars are unset — the pipeline runs end-to-end even with zero integrations
   configured.
5. Create a same-day reminder event via `services/googleCalendar.js` (same no-op-when-
   unconfigured pattern). A second call site, `createAppointmentEventForLead()`, fires from
   `routes/webhooks.js` (Calendly) and from the `PATCH /api/leads/:id` handler whenever
   `appointmentBookedAt` gets set — both routes had to become `async` handlers for this
   (safe in this Express 5 app: rejected promises in async handlers are auto-forwarded to
   the error middleware, no extra try/catch needed).

Everything is logged to the append-only `lead_events` table — this is both the dashboard's
activity timeline *and* the mechanism the follow-up scheduler and Calendly webhook rely on
for idempotency/observability, so new lead-affecting actions should log an event too.

`services/followupScheduler.js` runs on an in-process `setInterval` (default hourly, see
`FOLLOWUP_INTERVAL_MINUTES`) — no job queue. Stop conditions (opted out, contacted, terminal
status, all 3 stages sent) are enforced **directly in the candidate-selection SQL**, not just
in application logic, so a lead can't accidentally get double-sent if state changes between
runs. `POST /api/leads/run-followups` triggers a run manually for testing.

`routes/webhooks.js` (Calendly) is guarded by a shared-secret query token/header rather than
real HMAC signature verification, because it's never been exercised against a live Calendly
account — treat it as a first draft, not a template for other webhooks.

`services/settings.js` holds one flat key-value `settings` table (business name, email
templates, follow-up day thresholds, services list) with hardcoded `DEFAULTS` merged
underneath whatever's stored — this is the single-tenant business config, editable at
`/admin/lead-settings`. There is intentionally no multi-tenant/`client_id` scoping yet
(see README "Limitations") — don't bolt per-client isolation onto this table; it needs a
real `clients` table and scoping across `leads`/`lead_files`/`lead_events`/`settings` first.

### Integrations degrade, never break

OpenAI, SMTP, Calendly, and Google Calendar are all optional at boot by design. The pattern
used throughout (`aiQualify.isConfigured()`, `email.isConfigured()`, the
`CALENDLY_WEBHOOK_SECRET` check, `googleCalendar.isConfigured()`) is to check configuration
and return a structured "not configured"/fallback result — never throw or crash the request.
Preserve this pattern for any new integration.

Google Calendar is also the one integration whose credential isn't just an env var — env vars
(`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) only enable the OAuth flow itself; the resulting
refresh token comes from a one-time interactive "Connect Google Calendar" click at
`/admin/lead-settings` (`routes/googleAuth.js`) and is stored in its own `google_calendar_auth`
table — deliberately *not* in the generic `settings` table, since `services/settings.js`'s
`getSettings()` does an unfiltered `SELECT *` that flows straight into the `GET /api/settings`
response. Follow that separation for any future integration that stores a secret generated at
runtime (as opposed to one pasted into `.env`): it must not be reachable through `getSettings()`.

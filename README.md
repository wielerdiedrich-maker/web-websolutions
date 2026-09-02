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

## DW Lead Machine

An AI-assisted lead capture and follow-up system, built as a reusable
module inside this same backend. **Phase 1** (this build): lead form → AI
qualification → dashboard → email confirmation/notification → automated
follow-up → booking hook. **Phase 2** (not built yet, by design — see
Limitations): SMS/Twilio, an AI website chat assistant, missed-call
automation, automated review requests, and multi-tenant client isolation.

### What was built

1. **Embeddable lead form** — `public/js/lead-form.js` is a dependency-free,
   namespaced (`dwlm-` prefixed) widget script. Drop a
   `<div id="dw-lead-machine" data-endpoint="/api/leads" data-business="..."
   data-services="A,B,C">` anywhere and include the script — it renders a
   mobile-friendly quote form (name, email, phone, company, service,
   description, budget, timeframe, preferred contact method, preferred
   appointment time, multi-file upload) and posts it as `multipart/form-data`
   to `/api/leads`. This is the reusable piece you'd copy onto a client's
   site.
2. **AI lead qualification** — `server/services/aiQualify.js` calls OpenAI
   (Chat Completions, JSON mode) with a system prompt that explicitly
   forbids inventing pricing, guarantees, or availability, and instructs it
   to flag missing information rather than assume it. Returns a `HOT` /
   `WARM` / `COLD` / `NEEDS_INFO` status, a summary, a recommended action,
   and a missing-info list. Falls back to a transparent rule-based
   classifier (clearly labeled as such in the dashboard) when
   `OPENAI_API_KEY` isn't set, so the pipeline never breaks or fakes an AI
   response.
3. **Lead dashboard** — `/admin/leads`: stat tiles (New, Hot, Needs
   Follow-Up, Appointments, Won, Lost, conversion rate), search/filter by
   status and AI status, and a detail view per lead with the AI summary,
   missing info, uploaded files, notes, status control, contacted/opt-out
   toggles, and a full activity timeline.
4. **Automatic customer confirmation email** — sent immediately on
   submission, using an editable template (`{{first_name}}`,
   `{{business_name}}`, `{{booking_url}}`, `{{service}}` placeholders).
5. **Owner notification email** — sent immediately with the AI summary,
   recommended action, and a deep link into `/admin/leads?id=...`.
6. **Automated follow-up sequence** — `server/services/followupScheduler.js`
   runs in-process on a timer (default hourly, configurable) and sends up to
   3 staged follow-ups (default day 1 / 3 / 7, all configurable) by email.
   Stops automatically the moment a lead is marked contacted, moves to
   Appointment Booked / Won / Lost, or opts out — enforced directly in the
   SQL query that selects candidates, not just app-level logic. Every
   follow-up email includes a one-click unsubscribe link
   (`GET /api/leads/unsubscribe?token=...`).
7. **Booking hook** — a configurable booking URL surfaces in the
   confirmation/follow-up emails, and `POST /api/webhooks/calendly` marks a
   lead "Appointment Booked" (which halts further follow-up) when Calendly
   sends a booking event. **This webhook hasn't been tested against a real
   Calendly account** — see Limitations.
8. **Business knowledge / settings** — `/admin/lead-settings`: business
   name, sender identity, owner notification email, booking/review URLs,
   services list, follow-up timing, and every email template, plus a live
   "configured / not configured" readout for OpenAI, email, and Calendly.
9. **DW Laser demo** — `public/dw-laser.html` is the first real-world test
   deployment described in the original spec: a branded page embedding the
   widget, configured for a laser-engraving business.

### Database structure (`server/db.js`)

- `leads` — one row per submission: contact fields, `status` (New /
  Contacted / Qualified / Appointment Booked / Quote Sent / Won / Lost /
  Needs Follow-Up), `ai_status` (HOT/WARM/COLD/NEEDS_INFO) + AI
  summary/recommended action/missing info/engine, `notes`, `contacted_at`,
  `appointment_booked_at`, `opted_out`, `follow_up_stage` (0–3),
  `unsubscribe_token`.
- `lead_files` — join table linking a lead to rows in the existing `media`
  table (lead uploads reuse the same magic-byte-verified processing
  pipeline as the media library, just tagged into a `leads` folder).
- `lead_events` — append-only activity log per lead (form submitted, AI
  qualified, emails sent/failed, status changes, follow-ups sent, opt-outs)
  — this is what powers the dashboard's activity timeline and lets the
  follow-up scheduler avoid double-sending.
- `settings` — generic key/value store for the business config described
  above (single business for now; see Limitations re: multi-tenant).

### API surface

- `POST /api/leads` — public, rate-limited (8/15min/IP), accepts the form
  fields + up to 8 files.
- `GET /api/leads/unsubscribe?token=...` — public one-click opt-out.
- `GET /api/leads`, `GET /api/leads/:id`, `PATCH /api/leads/:id`,
  `DELETE /api/leads/:id` — admin-only.
- `POST /api/leads/run-followups` — admin-only manual trigger for the
  follow-up scheduler (handy for testing without waiting for the timer).
- `GET /api/settings`, `PUT /api/settings` — admin-only.
- `POST /api/webhooks/calendly?token=...` — Calendly booking webhook,
  guarded by `CALENDLY_WEBHOOK_SECRET`; responds `501` until that's set.

### Configuring each integration

All three are optional at boot — the system runs, accepts leads, and shows
"Integration not configured" (readout at `/admin/lead-settings`) instead of
erroring when any of these are unset.

- **OpenAI**: set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default
  `gpt-4o-mini`) in `.env`. Get a key at
  https://platform.openai.com/api-keys.
- **Email (SMTP, via `nodemailer`)**: set `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_FROM` in `.env`. Works with
  any SMTP provider — a Gmail account with an app password, SendGrid,
  Postmark, etc.
- **Calendly**: set a `CALENDLY_WEBHOOK_SECRET` value in `.env`, then
  register a webhook subscription pointing at
  `https://your-domain/api/webhooks/calendly?token=<same value>` via
  Calendly's API. Real signature verification (Calendly issues an HMAC
  signing key per subscription) should replace the current shared-secret
  check once you have a live Calendly account to test against.

### Creating a new client (manual, for now)

Phase 1 is single-tenant — see Limitations. To point this instance at a
different business today: edit the values at `/admin/lead-settings`
(business name, sender identity, services, booking/review URLs, follow-up
timing, templates) and change the `data-*` attributes on that business's
embedded `<div id="dw-lead-machine">`. A real "Create New Client" flow needs
the multi-tenant work described below first.

### How to test

```bash
npm install
cp .env.example .env   # fill in SESSION_SECRET + ADMIN_PASSWORD_HASH at minimum
npm run dev
```

- Submit a lead: open `/dw-laser.html`, fill out the form (leave
  `OPENAI_API_KEY`/`SMTP_*` unset to see the graceful fallbacks in action),
  submit.
- Check `/admin/leads`: the new lead should appear with an AI status (rule-
  based fallback if no OpenAI key), and the activity timeline should show
  `form_submitted` → `ai_qualified` → `customer_confirmation_failed` /
  `owner_notification_failed` (expected, since SMTP isn't configured) —
  set real SMTP credentials to see `_sent` instead.
- Missing info: submit with a vague one-line description and no
  budget/timeframe — AI status should come back `NEEDS_INFO` with
  populated "missing info".
- Follow-up stop conditions: open the lead, check "Marked contacted" and
  save — then hit "Run follow-ups now" on the Leads page; that lead should
  be skipped (`skipped` count increments, not `sent`).
- Opt-out: use the unsubscribe link included in a follow-up email (or set
  `opted_out` via the admin checkbox) — same check, it drops out of future
  runs.
- Appointment booked: set a lead's status to "Appointment Booked" in the
  dashboard (simulating what the Calendly webhook does) — follow-ups stop
  for the same reason.

### Limitations

- **Not built in this pass** (per the phased approach — build these next):
  SMS/Twilio, the AI website chat assistant, missed-call automation, and
  automated post-completion review requests. The `review_request_template`
  setting exists but nothing sends it yet.
- **Single-tenant.** Multi-client data isolation (separate leads/settings/
  branding per business, with one client never able to see another's data)
  is a real architectural undertaking — new `clients` table, a
  `client_id` column across `leads`/`lead_files`/`lead_events`/`settings`,
  and auth scoped per client — intentionally deferred rather than bolted on
  under this settings table. Do this before selling to a second client.
- **Calendly webhook is untested** against a real Calendly account/signing
  key (none were available while building this) — the endpoint exists and
  is guarded by a shared secret, but treat it as a first draft.
- **Follow-up scheduler runs in-process** (a `setInterval`, like the
  existing session store) rather than a real job queue — fine at this
  scale, but means follow-ups pause if the process restarts between checks
  (they simply resume on the next tick, nothing is lost, just possibly
  delayed) and won't survive a multi-instance deployment without moving to
  a shared queue.
- **AI qualification quality** depends entirely on the OpenAI account you
  configure — this build doesn't include prompt evaluation/tuning against
  real historical leads.

### Estimated monthly operating cost (rough, verify current pricing)

- **OpenAI**: `gpt-4o-mini` is priced per token; a single lead-qualification
  call is a few hundred tokens in, ~150 out — even at a few hundred leads/
  month this is on the order of a few dollars/month, not a meaningful cost
  driver. Verify current pricing at https://openai.com/api/pricing.
- **Email**: free-to-low-cost at this volume on most transactional
  providers (a Gmail account works for testing; use a real transactional
  provider like SendGrid/Postmark/SES in production — check their current
  free-tier limits).
- **Calendly**: free tier covers one event type; paid tiers (needed for
  some webhook/automation features) are typically in the ~$10–20/month/user
  range — verify at calendly.com/pricing.
- **Twilio/SMS** (Phase 2, not built): per-message + phone number rental;
  budget roughly $1–2/month for the number plus a small per-SMS cost —
  verify at twilio.com/pricing before committing.

These are ballpark figures based on typical published pricing patterns, not
a quote — confirm current numbers before relying on them for a business
plan.

### Security considerations

- File uploads reuse the existing magic-byte-verified, size-capped,
  SVG-sanitized pipeline (`server/mediaProcessor.js`) — no new upload attack
  surface.
- All admin endpoints require the same authenticated session + CSRF-style
  `X-Requested-With` header as the rest of the admin API; nothing new was
  exempted from `requireAuth`.
- No API keys or secrets are ever sent to the browser — OpenAI/SMTP/Calendly
  calls are all server-side, credentials come only from environment
  variables, and `/admin/lead-settings` only ever displays
  configured/not-configured booleans, never the underlying secret values.
- The public lead-submission and unsubscribe endpoints are rate-limited;
  the Calendly webhook is disabled by default and requires a shared secret
  once enabled.
- Multi-tenant isolation is **not yet implemented** — do not onboard a
  second real client's data onto this instance until that's built (see
  Limitations).

### Recommended next steps

1. Configure real OpenAI + SMTP credentials and run a handful of real leads
   through DW Laser to sanity-check AI qualification quality and email
   deliverability before showing it to prospects.
2. Register a real Calendly webhook subscription and verify the booking
   flow end-to-end (currently untested).
3. Build the multi-tenant `clients` table + `client_id` scoping before
   onboarding a second business.
4. Phase 2: Twilio/SMS follow-up, the AI website chat assistant (with a
   "talk to a real person" escalation), missed-call automation, and
   automated review requests on job completion.

## Extending this later

Products, services, pages, blog posts, testimonials, portfolio entries,
pricing, and SEO settings can each follow the same pattern as `media` and
`contact_messages`: a table in `server/db.js`, a router in `server/routes/`,
and a section in the admin sidebar (already stubbed as "coming soon" in
`server/admin-ui/index.html`) — all can reference existing uploaded media by
id rather than re-implementing upload handling.

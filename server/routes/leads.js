const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const { requireAuth, requireSameOriginHeader } = require('../auth');
const { processUpload, ValidationError } = require('../mediaProcessor');
const { getSettings, fillTemplate } = require('../services/settings');
const { sendEmail } = require('../services/email');
const { qualifyLead } = require('../services/aiQualify');
const { runFollowupsNow } = require('../services/followupScheduler');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMINAL_STATUSES = new Set(['Appointment Booked', 'Won', 'Lost']);

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg', '.mp4', '.webm', '.mov']);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new ValidationError(`File type not allowed: ${file.originalname}`));
    }
    cb(null, true);
  },
});

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function logEvent(leadId, type, detail) {
  db.prepare('INSERT INTO lead_events (id, lead_id, type, detail) VALUES (?, ?, ?, ?)').run(
    uuidv4(),
    leadId,
    type,
    detail ? String(detail).slice(0, 2000) : null
  );
}

function serializeLead(row, { withFiles = false, withEvents = false } = {}) {
  const out = {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    service: row.service,
    description: row.description,
    budget: row.budget,
    timeframe: row.timeframe,
    preferredContact: row.preferred_contact,
    preferredAppointmentTime: row.preferred_appointment_time,
    status: row.status,
    aiStatus: row.ai_status,
    aiSummary: row.ai_summary,
    aiRecommendedAction: row.ai_recommended_action,
    aiMissingInfo: row.ai_missing_info ? JSON.parse(row.ai_missing_info) : [],
    aiEngine: row.ai_engine,
    notes: row.notes,
    contactedAt: row.contacted_at,
    appointmentBookedAt: row.appointment_booked_at,
    optedOut: Boolean(row.opted_out),
    followUpStage: row.follow_up_stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withFiles) {
    out.files = db
      .prepare(
        `SELECT m.id, m.original_name, m.kind, m.mime_type, m.optimized_path, m.thumb_path
         FROM lead_files lf JOIN media m ON m.id = lf.media_id
         WHERE lf.lead_id = ? ORDER BY lf.created_at ASC`
      )
      .all(row.id)
      .map((m) => ({
        id: m.id,
        name: m.original_name,
        kind: m.kind,
        mimeType: m.mime_type,
        url: '/' + m.optimized_path,
        thumbUrl: m.thumb_path ? '/' + m.thumb_path : '/' + m.optimized_path,
      }));
  }
  if (withEvents) {
    out.events = db
      .prepare('SELECT type, detail, created_at FROM lead_events WHERE lead_id = ? ORDER BY created_at DESC')
      .all(row.id);
  }
  return out;
}

// --- Public: submit a new lead through the embeddable form.
router.post('/', submitLimiter, upload.array('files', 8), async (req, res) => {
  const body = req.body || {};
  const name = clean(body.name);
  const email = clean(body.email);
  const phone = clean(body.phone);
  const company = clean(body.company);
  const service = clean(body.service);
  const description = clean(body.description);
  const budget = clean(body.budget);
  const timeframe = clean(body.timeframe);
  const preferredContact = clean(body['preferred-contact'] || body.preferredContact);
  const preferredAppointmentTime = clean(body['preferred-appointment-time'] || body.preferredAppointmentTime);

  const cleanupFiles = () => Promise.all((req.files || []).map((f) => fs.unlink(f.path).catch(() => {})));

  if (!name || !email || !service || !description) {
    await cleanupFiles();
    return res.status(400).json({ error: 'Name, email, service, and project description are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    await cleanupFiles();
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const id = uuidv4();
  const unsubscribeToken = uuidv4();

  try {
    db.prepare(
      `INSERT INTO leads (
        id, name, email, phone, company, service, description, budget, timeframe,
        preferred_contact, preferred_appointment_time, unsubscribe_token
      ) VALUES (@id, @name, @email, @phone, @company, @service, @description, @budget, @timeframe,
        @preferred_contact, @preferred_appointment_time, @unsubscribe_token)`
    ).run({
      id,
      name: name.slice(0, 200),
      email: email.slice(0, 254),
      phone: phone.slice(0, 50),
      company: company.slice(0, 200),
      service: service.slice(0, 200),
      description: description.slice(0, 5000),
      budget: budget.slice(0, 200),
      timeframe: timeframe.slice(0, 200),
      preferred_contact: preferredContact.slice(0, 50),
      preferred_appointment_time: preferredAppointmentTime.slice(0, 200),
      unsubscribe_token: unsubscribeToken,
    });
    logEvent(id, 'form_submitted');

    // File uploads reuse the same magic-byte-verified pipeline as the media
    // library, just tagged into a dedicated folder and linked via lead_files.
    const insertMedia = db.prepare(`
      INSERT INTO media (id, original_name, stored_name, kind, mime_type, size_bytes, width, height,
        duration_seconds, folder, original_path, optimized_path, thumb_path)
      VALUES (@id, @original_name, @stored_name, @kind, @mime_type, @size_bytes, @width, @height,
        @duration_seconds, 'leads', @original_path, @optimized_path, @thumb_path)
    `);
    const linkFile = db.prepare('INSERT INTO lead_files (id, lead_id, media_id) VALUES (?, ?, ?)');
    let fileCount = 0;
    for (const file of req.files || []) {
      try {
        const processed = await processUpload(file.path, file.originalname, file.mimetype);
        const mediaId = uuidv4();
        insertMedia.run({
          id: mediaId,
          original_name: file.originalname.slice(0, 255),
          stored_name: processed.storedName,
          kind: processed.kind,
          mime_type: processed.mimeType,
          size_bytes: processed.sizeBytes,
          width: processed.width,
          height: processed.height,
          duration_seconds: processed.durationSeconds,
          original_path: processed.originalRelPath,
          optimized_path: processed.optimizedRelPath,
          thumb_path: processed.thumbRelPath,
        });
        linkFile.run(uuidv4(), id, mediaId);
        fileCount++;
      } catch (err) {
        logEvent(id, 'file_rejected', `${file.originalname}: ${err.message}`);
      } finally {
        await fs.unlink(file.path).catch(() => {});
      }
    }

    const settings = getSettings();

    // AI qualification — awaited so the dashboard has a status the moment
    // the lead lands; a slow/failed OpenAI call degrades to the rule-based
    // classifier rather than blocking or breaking the submission.
    const qualification = await qualifyLead(
      { name, email, service, description, budget, timeframe, preferred_contact: preferredContact, preferred_appointment_time: preferredAppointmentTime, fileCount },
      settings.services
    );
    db.prepare(
      `UPDATE leads SET ai_status = @ai_status, ai_summary = @ai_summary, ai_recommended_action = @ai_recommended_action,
        ai_missing_info = @ai_missing_info, ai_engine = @ai_engine, updated_at = @updated_at WHERE id = @id`
    ).run({
      id,
      ai_status: qualification.status,
      ai_summary: qualification.summary,
      ai_recommended_action: qualification.recommended_action,
      ai_missing_info: JSON.stringify(qualification.missing_info),
      ai_engine: qualification.engine,
      updated_at: new Date().toISOString(),
    });
    logEvent(id, 'ai_qualified', `${qualification.status} via ${qualification.engine}`);

    const firstName = name.split(/\s+/)[0];
    const templateVars = {
      first_name: firstName,
      business_name: settings.business_name,
      booking_url: settings.booking_url || '(not configured)',
      service,
    };

    const confirmResult = await sendEmail({
      to: email,
      subject: fillTemplate(settings.confirmation_subject, templateVars),
      text: fillTemplate(settings.confirmation_template, templateVars),
      fromName: settings.sender_name,
      fromEmail: settings.sender_email,
    });
    logEvent(id, confirmResult.sent ? 'customer_confirmation_sent' : 'customer_confirmation_failed', confirmResult.reason);

    if (settings.owner_notification_email) {
      const hotBadge = qualification.status === 'HOT' ? '🔥 NEW HOT LEAD' : `NEW ${qualification.status} LEAD`;
      const ownerText = [
        `${hotBadge}`,
        '',
        `${name}`,
        `Service: ${service}`,
        `Phone: ${phone || '(not provided)'}`,
        `Email: ${email}`,
        `Lead status: ${qualification.status}`,
        '',
        'AI Summary:',
        qualification.summary || '(none)',
        '',
        'Recommended action:',
        qualification.recommended_action || '(none)',
        qualification.missing_info.length ? `\nMissing information: ${qualification.missing_info.join(', ')}` : '',
        '',
        `View lead: ${req.protocol}://${req.get('host')}/admin/leads?id=${id}`,
      ]
        .filter((l) => l !== '')
        .join('\n');

      const ownerResult = await sendEmail({
        to: settings.owner_notification_email,
        subject: `${hotBadge} — ${name} (${service})`,
        text: ownerText,
        fromName: settings.sender_name,
        fromEmail: settings.sender_email,
      });
      logEvent(id, ownerResult.sent ? 'owner_notified' : 'owner_notification_failed', ownerResult.reason);
    }

    res.status(201).json({ id, status: 'New', aiStatus: qualification.status });
  } catch (err) {
    console.error('[leads] Submission failed:', err);
    res.status(500).json({ error: 'Something went wrong submitting your request. Please try again.' });
  }
});

// --- Public: one-click unsubscribe from automated follow-up.
router.get('/unsubscribe', (req, res) => {
  const token = clean(req.query.token);
  const lead = token ? db.prepare('SELECT id FROM leads WHERE unsubscribe_token = ?').get(token) : null;
  if (!lead) {
    return res.status(404).send('<p style="font-family:sans-serif;padding:40px;">Invalid or expired unsubscribe link.</p>');
  }
  db.prepare('UPDATE leads SET opted_out = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), lead.id);
  logEvent(lead.id, 'opted_out', 'via unsubscribe link');
  res.send('<p style="font-family:sans-serif;padding:40px;">You’ve been unsubscribed from automated follow-up messages. If this was a mistake, just reply to any of our emails.</p>');
});

// --- Everything below is admin-only.
router.use(requireAuth);

router.get('/', (req, res) => {
  const { q, status, aiStatus, optedOut } = req.query;
  const clauses = [];
  const params = {};
  if (q) {
    clauses.push('(name LIKE @q OR email LIKE @q OR service LIKE @q OR company LIKE @q)');
    params.q = `%${q}%`;
  }
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (aiStatus) {
    clauses.push('ai_status = @aiStatus');
    params.aiStatus = aiStatus;
  }
  if (optedOut === 'true' || optedOut === 'false') {
    clauses.push('opted_out = @optedOut');
    params.optedOut = optedOut === 'true' ? 1 : 0;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC`).all(params);

  const fileCounts = Object.fromEntries(
    db.prepare('SELECT lead_id, COUNT(*) as c FROM lead_files GROUP BY lead_id').all().map((r) => [r.lead_id, r.c])
  );

  const stats = {
    total: rows.length,
    new: rows.filter((r) => r.status === 'New').length,
    hot: rows.filter((r) => r.ai_status === 'HOT').length,
    needsFollowUp: rows.filter(
      (r) => !r.opted_out && !r.contacted_at && !TERMINAL_STATUSES.has(r.status) && r.follow_up_stage < 3
    ).length,
    appointmentsBooked: rows.filter((r) => r.status === 'Appointment Booked').length,
    won: rows.filter((r) => r.status === 'Won').length,
    lost: rows.filter((r) => r.status === 'Lost').length,
  };
  const decided = stats.won + stats.lost;
  stats.conversionRate = decided ? Math.round((stats.won / decided) * 100) : null;

  res.json({
    leads: rows.map((r) => ({ ...serializeLead(r), fileCount: fileCounts[r.id] || 0 })),
    stats,
  });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Lead not found.' });
  res.json(serializeLead(row, { withFiles: true, withEvents: true }));
});

router.patch('/:id', requireSameOriginHeader, (req, res) => {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Lead not found.' });

  const VALID_STATUS = new Set([
    'New', 'Contacted', 'Qualified', 'Appointment Booked', 'Quote Sent', 'Won', 'Lost', 'Needs Follow-Up',
  ]);
  const updates = { updated_at: new Date().toISOString() };
  const { status, notes, contacted, optedOut, appointmentBookedAt } = req.body;

  if (status !== undefined) {
    if (!VALID_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status.' });
    updates.status = status;
    logEvent(row.id, 'status_changed', `${row.status} → ${status}`);
  }
  if (notes !== undefined) {
    updates.notes = String(notes).slice(0, 5000);
  }
  if (contacted === true && !row.contacted_at) {
    updates.contacted_at = new Date().toISOString();
    logEvent(row.id, 'marked_contacted');
  } else if (contacted === false) {
    updates.contacted_at = null;
  }
  if (optedOut !== undefined) {
    updates.opted_out = optedOut ? 1 : 0;
    logEvent(row.id, optedOut ? 'opted_out' : 'opted_in', 'via admin');
  }
  if (appointmentBookedAt !== undefined) {
    updates.appointment_booked_at = appointmentBookedAt || null;
    if (appointmentBookedAt) {
      updates.status = 'Appointment Booked';
      logEvent(row.id, 'appointment_booked', appointmentBookedAt);
    }
  }

  const setClause = Object.keys(updates)
    .map((k) => `${k} = @${k}`)
    .join(', ');
  db.prepare(`UPDATE leads SET ${setClause} WHERE id = @id`).run({ ...updates, id: row.id });

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.id);
  res.json(serializeLead(updated, { withFiles: true, withEvents: true }));
});

router.delete('/:id', requireSameOriginHeader, (req, res) => {
  const result = db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// --- Manual trigger for the follow-up scheduler, useful for testing
// without waiting for the interval timer.
router.post('/run-followups', requireSameOriginHeader, async (req, res) => {
  const result = await runFollowupsNow();
  res.json(result);
});

module.exports = router;

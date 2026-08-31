const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { requireAuth, requireSameOriginHeader } = require('../auth');
const { sendContactNotification } = require('../mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

// --- Public: submit the "work order" form. No auth — this is what
// anonymous visitors hit. Protected by rate limiting + a honeypot field
// instead of the admin CSRF header, since real visitors never see that.
router.post('/contact', contactLimiter, async (req, res) => {
  const { name, email, 'business-type': businessType, details, website } = req.body || {};

  // Honeypot: a hidden field real visitors never fill in. Bots that
  // auto-fill every field will trip it. Pretend success either way so
  // scrapers don't learn to skip the field.
  if (website) {
    return res.json({ ok: true });
  }

  const cleanName = typeof name === 'string' ? name.trim().slice(0, 200) : '';
  const cleanEmail = typeof email === 'string' ? email.trim().slice(0, 254) : '';
  const cleanBusinessType = typeof businessType === 'string' ? businessType.trim().slice(0, 100) : '';
  const cleanDetails = typeof details === 'string' ? details.trim().slice(0, 5000) : '';

  if (!cleanName || !cleanEmail || !cleanDetails) {
    return res.status(400).json({ error: 'Name, email, and project details are required.' });
  }
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const id = uuidv4();
  const emailSent = await sendContactNotification({
    name: cleanName,
    email: cleanEmail,
    businessType: cleanBusinessType,
    details: cleanDetails,
  });

  db.prepare(
    `INSERT INTO contact_messages (id, name, email, business_type, details, email_sent)
     VALUES (@id, @name, @email, @businessType, @details, @emailSent)`
  ).run({
    id,
    name: cleanName,
    email: cleanEmail,
    businessType: cleanBusinessType,
    details: cleanDetails,
    emailSent: emailSent ? 1 : 0,
  });

  res.json({ ok: true });
});

// --- Admin: view/manage submitted leads.
function serializeMessage(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    businessType: row.business_type,
    details: row.details,
    emailSent: Boolean(row.email_sent),
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

router.get('/messages', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  res.json(rows.map(serializeMessage));
});

router.patch('/messages/:id', requireAuth, requireSameOriginHeader, (req, res) => {
  const row = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found.' });
  const isRead = Boolean(req.body && req.body.isRead);
  db.prepare('UPDATE contact_messages SET is_read = ? WHERE id = ?').run(isRead ? 1 : 0, row.id);
  res.json(serializeMessage(db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(row.id)));
});

router.delete('/messages/:id', requireAuth, requireSameOriginHeader, (req, res) => {
  const result = db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
});

module.exports = router;

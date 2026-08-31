const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { requireAuth, requireSameOriginHeader } = require('../auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEN = { name: 200, email: 254, business_type: 100, details: 5000 };

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// --- Public: submit a work-order / contact form entry.
router.post('/', submitLimiter, (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email);
  const businessType = clean(req.body['business-type'] || req.body.businessType);
  const details = clean(req.body.details);

  if (!name || !email || !businessType || !details) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (
    name.length > MAX_LEN.name ||
    email.length > MAX_LEN.email ||
    businessType.length > MAX_LEN.business_type ||
    details.length > MAX_LEN.details
  ) {
    return res.status(400).json({ error: 'One or more fields are too long.' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO contact_messages (id, name, email, business_type, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, email, businessType, details);

  res.status(201).json({ id });
});

// --- Admin: list submissions, newest first.
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM contact_messages ORDER BY created_at DESC')
    .all();
  res.json({ messages: rows });
});

// --- Admin: mark a submission read/unread.
router.patch('/:id/read', requireAuth, requireSameOriginHeader, (req, res) => {
  const readAt = req.body.read === false ? null : new Date().toISOString();
  const result = db
    .prepare('UPDATE contact_messages SET read_at = ? WHERE id = ?')
    .run(readAt, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

// --- Admin: delete a submission.
router.delete('/:id', requireAuth, requireSameOriginHeader, (req, res) => {
  const result = db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

module.exports = router;

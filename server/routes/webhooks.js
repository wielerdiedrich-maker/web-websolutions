const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { getSettings } = require('../services/settings');
const { sendEmail } = require('../services/email');

const router = express.Router();

function logEvent(leadId, type, detail) {
  db.prepare('INSERT INTO lead_events (id, lead_id, type, detail) VALUES (?, ?, ?, ?)').run(
    uuidv4(),
    leadId,
    type,
    detail ? String(detail).slice(0, 2000) : null
  );
}

/**
 * Calendly booking webhook.
 *
 * Real Calendly webhook signature verification uses an HMAC-SHA256 signing
 * key issued when you register the webhook subscription via Calendly's API
 * (see https://developer.calendly.com/api-docs — Webhook Signatures). We
 * don't have a live Calendly account/credentials to register a subscription
 * against yet, so this endpoint is guarded by a simple shared secret
 * (CALENDLY_WEBHOOK_SECRET, passed as ?token=...) instead — real signature
 * verification should replace this once real credentials exist.
 *
 * Until CALENDLY_WEBHOOK_SECRET is set, this route responds 501 rather than
 * silently accepting unverified requests.
 */
router.post('/calendly', (req, res) => {
  const expected = process.env.CALENDLY_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(501).json({ error: 'Calendly integration not configured.' });
  }
  const provided = req.query.token || req.get('X-Webhook-Token');
  const ok =
    typeof provided === 'string' &&
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return res.status(403).json({ error: 'Invalid webhook token.' });
  }

  // Calendly v2 webhook payload shape: { event, payload: { email, scheduled_event: { start_time } } }.
  // Accept a couple of reasonable shapes defensively since this hasn't been
  // exercised against a real Calendly account yet.
  const body = req.body || {};
  const payload = body.payload || body;
  const email = payload.email || payload.invitee?.email;
  const startTime = payload.scheduled_event?.start_time || payload.start_time || new Date().toISOString();

  if (!email) {
    return res.status(400).json({ error: 'Could not find invitee email in webhook payload.' });
  }

  const lead = db
    .prepare(
      `SELECT * FROM leads WHERE email = ? AND status != 'Appointment Booked' ORDER BY created_at DESC LIMIT 1`
    )
    .get(email);

  if (!lead) {
    // Not an error — someone booked who never submitted the lead form. Ack
    // so Calendly doesn't retry, but don't fabricate a lead record.
    return res.status(200).json({ ok: true, matched: false });
  }

  db.prepare(
    `UPDATE leads SET status = 'Appointment Booked', appointment_booked_at = ?, updated_at = ? WHERE id = ?`
  ).run(startTime, new Date().toISOString(), lead.id);
  logEvent(lead.id, 'appointment_booked', `via Calendly webhook, ${startTime}`);

  const settings = getSettings();
  if (settings.owner_notification_email) {
    sendEmail({
      to: settings.owner_notification_email,
      subject: `Appointment booked — ${lead.name}`,
      text: `${lead.name} booked an appointment for ${startTime}.\n\nService: ${lead.service}\nEmail: ${lead.email}\nPhone: ${lead.phone || '(not provided)'}`,
      fromName: settings.sender_name,
      fromEmail: settings.sender_email,
    }).catch((err) => console.error('[webhooks/calendly] Owner notification failed:', err));
  }

  res.status(200).json({ ok: true, matched: true, leadId: lead.id });
});

module.exports = router;

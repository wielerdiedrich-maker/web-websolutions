const nodemailer = require('nodemailer');

let transporter;
let warnedOnce = false;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Sends a notification email for a new contact submission. Returns true if
 * sent, false otherwise — never throws, so a mail outage can never prevent
 * the lead from being saved to the database (the source of truth).
 */
async function sendContactNotification({ name, email, businessType, details }) {
  const t = getTransporter();
  if (!t) {
    if (!warnedOnce) {
      console.warn(
        'Contact form: SMTP_HOST/SMTP_USER/SMTP_PASS not set — submissions are saved to the ' +
          'database and visible in /admin, but no email notification will be sent. See .env.example.'
      );
      warnedOnce = true;
    }
    return false;
  }

  const to = process.env.CONTACT_TO_EMAIL || process.env.SMTP_USER;
  const from = process.env.CONTACT_FROM_EMAIL || process.env.SMTP_USER;

  try {
    await t.sendMail({
      from,
      to,
      replyTo: email,
      subject: `New work order request — ${name}`,
      text:
        `Name: ${name}\n` +
        `Email: ${email}\n` +
        `Business type: ${businessType || 'Not specified'}\n\n` +
        `Details:\n${details}\n`,
    });
    return true;
  } catch (err) {
    console.error('Contact form: failed to send notification email:', err.message);
    return false;
  }
}

module.exports = { sendContactNotification, isConfigured };

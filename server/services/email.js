let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

let transporter = null;
let transporterError = null;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!nodemailer || !isConfigured()) return null;
  if (transporter) return transporter;
  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } catch (err) {
    transporterError = err;
  }
  return transporter;
}

/**
 * Sends an email if SMTP is configured; otherwise logs and returns a
 * structured "not configured" result instead of throwing, so the rest of
 * the lead pipeline (DB writes, AI qualification, dashboard) keeps working
 * even before a client fills in real credentials.
 */
async function sendEmail({ to, subject, text, fromName, fromEmail }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[email] Not configured — would have sent "${subject}" to ${to}`);
    return { sent: false, reason: transporterError ? 'transport_error' : 'not_configured' };
  }
  const from = fromEmail
    ? `"${fromName || fromEmail}" <${fromEmail}>`
    : process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await t.sendMail({ from, to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

module.exports = { sendEmail, isConfigured };

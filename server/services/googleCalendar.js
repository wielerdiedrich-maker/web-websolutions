const { google } = require('googleapis');
const db = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

const getAuthRow = db.prepare('SELECT * FROM google_calendar_auth WHERE id = 1');
const upsertAuthRow = db.prepare(`
  INSERT INTO google_calendar_auth (id, refresh_token, account_email, calendar_id)
  VALUES (1, @refresh_token, @account_email, @calendar_id)
  ON CONFLICT(id) DO UPDATE SET
    refresh_token = excluded.refresh_token,
    account_email = excluded.account_email,
    calendar_id = excluded.calendar_id,
    connected_at = datetime('now')
`);
const deleteAuthRow = db.prepare('DELETE FROM google_calendar_auth WHERE id = 1');

function hasAppCredentials() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${base}/api/google/oauth/callback`;
}

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

function isConfigured() {
  return hasAppCredentials() && Boolean(getAuthRow.get());
}

function connectionStatus() {
  const row = hasAppCredentials() ? getAuthRow.get() : null;
  return {
    appCredentialsConfigured: hasAppCredentials(),
    connected: Boolean(row),
    accountEmail: row ? row.account_email : null,
  };
}

function getAuthUrl(state) {
  const client = newOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token even on a re-connect
    scope: SCOPES,
    state,
  });
}

/**
 * Exchanges an OAuth "code" for tokens and stores the refresh token. Called
 * once, interactively, from the admin "Connect Google Calendar" flow.
 */
async function handleOAuthCallback(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke this app\'s access at ' +
        'https://myaccount.google.com/permissions and try connecting again.'
    );
  }
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data: userinfo } = await oauth2.userinfo.get();

  upsertAuthRow.run({
    refresh_token: tokens.refresh_token,
    account_email: userinfo.email || null,
    calendar_id: 'primary',
  });
  return { accountEmail: userinfo.email || null };
}

function disconnect() {
  deleteAuthRow.run();
}

function getAuthorizedClient() {
  const row = getAuthRow.get();
  if (!hasAppCredentials() || !row) return null;
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: row.refresh_token });
  return { client, calendarId: row.calendar_id || 'primary' };
}

function leadDetailLines(lead) {
  return [
    `Service: ${lead.service || '(not specified)'}`,
    `Email: ${lead.email}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.company ? `Company: ${lead.company}` : null,
  ].filter(Boolean);
}

/**
 * Creates a same-day reminder event so a new lead never sits unnoticed,
 * even before anyone has responded. Never throws — returns a structured
 * result, same degrade-gracefully pattern as services/email.js.
 */
async function createReminderEventForLead(lead, { dashboardUrl } = {}) {
  const authorized = getAuthorizedClient();
  if (!authorized) return { created: false, reason: 'not_configured' };

  const start = new Date();
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  try {
    const calendar = google.calendar({ version: 'v3', auth: authorized.client });
    const { data } = await calendar.events.insert({
      calendarId: authorized.calendarId,
      requestBody: {
        summary: `Follow up: ${lead.name} — ${lead.service}`,
        description: [lead.aiSummary || lead.description, '', ...leadDetailLines(lead), dashboardUrl ? `\nView lead: ${dashboardUrl}` : '']
          .filter(Boolean)
          .join('\n'),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
      },
    });
    return { created: true, eventId: data.id, htmlLink: data.htmlLink };
  } catch (err) {
    console.error('[googleCalendar] Reminder event failed:', err.message);
    return { created: false, reason: 'api_error', error: err.message };
  }
}

/**
 * Creates a real calendar event once an appointment time is confirmed
 * (from the Calendly webhook or an admin marking a lead Appointment Booked).
 */
async function createAppointmentEventForLead(lead, startTime, { dashboardUrl, durationMinutes = 60 } = {}) {
  const authorized = getAuthorizedClient();
  if (!authorized) return { created: false, reason: 'not_configured' };

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    return { created: false, reason: 'invalid_start_time' };
  }
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  try {
    const calendar = google.calendar({ version: 'v3', auth: authorized.client });
    const { data } = await calendar.events.insert({
      calendarId: authorized.calendarId,
      requestBody: {
        summary: `Appointment: ${lead.name} — ${lead.service}`,
        description: [...leadDetailLines(lead), dashboardUrl ? `\nView lead: ${dashboardUrl}` : '']
          .filter(Boolean)
          .join('\n'),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        reminders: { useDefault: true },
      },
    });
    return { created: true, eventId: data.id, htmlLink: data.htmlLink };
  } catch (err) {
    console.error('[googleCalendar] Appointment event failed:', err.message);
    return { created: false, reason: 'api_error', error: err.message };
  }
}

module.exports = {
  isConfigured,
  connectionStatus,
  getAuthUrl,
  handleOAuthCallback,
  disconnect,
  createReminderEventForLead,
  createAppointmentEventForLead,
};

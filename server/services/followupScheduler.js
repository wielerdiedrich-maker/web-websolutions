const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { getSettings, fillTemplate } = require('./settings');
const { sendEmail } = require('./email');

const TERMINAL_STATUSES = new Set(['Appointment Booked', 'Won', 'Lost']);
const DAY_MS = 24 * 60 * 60 * 1000;

let intervalHandle = null;

function logEvent(leadId, type, detail) {
  db.prepare('INSERT INTO lead_events (id, lead_id, type, detail) VALUES (?, ?, ?, ?)').run(
    uuidv4(),
    leadId,
    type,
    detail ? String(detail).slice(0, 2000) : null
  );
}

function parseSqliteDate(value) {
  // better-sqlite3's datetime('now') default is "YYYY-MM-DD HH:MM:SS" (UTC, no offset)
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}

/**
 * Sends the next due follow-up stage for every eligible lead. Eligibility
 * (all of these must hold, per the spec's stop conditions) is enforced by
 * the SQL WHERE clause itself, not just in application code, so a lead that
 * gets marked contacted/won/lost/opted-out between runs is simply absent
 * from the next batch — no separate "cancel" step needed.
 */
async function runFollowupsNow() {
  const settings = getSettings();
  const thresholds = [
    Number(settings.followup_1_days) || 1,
    Number(settings.followup_2_days) || 3,
    Number(settings.followup_3_days) || 7,
  ];
  const templates = [settings.followup_1_template, settings.followup_2_template, settings.followup_3_template];

  const candidates = db
    .prepare(
      `SELECT * FROM leads
       WHERE opted_out = 0
         AND contacted_at IS NULL
         AND status NOT IN ('Appointment Booked', 'Won', 'Lost')
         AND follow_up_stage < 3`
    )
    .all();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const lead of candidates) {
    try {
      // Defensive re-check in case TERMINAL_STATUSES / SQL list ever drift apart.
      if (lead.opted_out || lead.contacted_at || TERMINAL_STATUSES.has(lead.status)) {
        skipped++;
        continue;
      }
      const ageDays = (Date.now() - parseSqliteDate(lead.created_at).getTime()) / DAY_MS;
      const stage = lead.follow_up_stage; // 0, 1, or 2 -> next stage to send is stage+1
      if (ageDays < thresholds[stage]) {
        skipped++;
        continue;
      }

      const firstName = lead.name.split(/\s+/)[0];
      const vars = {
        first_name: firstName,
        business_name: settings.business_name,
        booking_url: settings.booking_url || '(not configured)',
        service: lead.service,
      };
      const unsubscribeUrl = `${process.env.PUBLIC_BASE_URL || ''}/api/leads/unsubscribe?token=${lead.unsubscribe_token}`;
      const text = `${fillTemplate(templates[stage], vars)}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;

      const result = await sendEmail({
        to: lead.email,
        subject: `Following up — ${settings.business_name}`,
        text,
        fromName: settings.sender_name,
        fromEmail: settings.sender_email,
      });

      db.prepare('UPDATE leads SET follow_up_stage = ?, updated_at = ? WHERE id = ?').run(
        stage + 1,
        new Date().toISOString(),
        lead.id
      );
      logEvent(lead.id, result.sent ? `follow_up_${stage + 1}_sent` : `follow_up_${stage + 1}_failed`, result.reason);
      if (result.sent) sent++;
      else failed++;
    } catch (err) {
      console.error(`[followupScheduler] Failed processing lead ${lead.id}:`, err);
      failed++;
    }
  }

  return { checked: candidates.length, sent, skipped, failed };
}

function start() {
  if (intervalHandle) return;
  const minutes = Number(process.env.FOLLOWUP_INTERVAL_MINUTES) || 60;
  intervalHandle = setInterval(() => {
    runFollowupsNow().catch((err) => console.error('[followupScheduler] Run failed:', err));
  }, minutes * 60 * 1000);
  // Also do an initial pass shortly after boot, without blocking startup.
  setTimeout(() => {
    runFollowupsNow().catch((err) => console.error('[followupScheduler] Initial run failed:', err));
  }, 15 * 1000);
  console.log(`[followupScheduler] Started — checking every ${minutes} minute(s).`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, runFollowupsNow };

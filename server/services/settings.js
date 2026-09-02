const db = require('../db');

// Defaults describe the first real-world DW Lead Machine deployment: the
// "DW Laser" demo business (see README "DW Lead Machine" section). Every
// value here is editable at /admin/lead-settings — nothing below is meant
// to be permanent, it's just a working starting point so the system is
// never blank/broken on first boot.
const DEFAULTS = {
  business_name: 'DW Laser',
  sender_name: 'DW Laser',
  sender_email: '',
  owner_notification_email: 'wielerdiedrich@gmail.com',
  booking_url: '',
  review_url: '',
  services: JSON.stringify([
    'Custom Engraved Tumblers',
    'Signage & Plaques',
    'Corporate / Bulk Orders',
    'Awards & Recognition',
    'Other',
  ]),
  followup_1_days: '1',
  followup_2_days: '3',
  followup_3_days: '7',
  confirmation_subject: "We've received your request — {{business_name}}",
  confirmation_template:
    "Hi {{first_name}},\n\nThanks for contacting {{business_name}}. We've received your request and our team will review the details.\n\nWe'll be in touch shortly.\n\nIf you'd like to speak with us directly, you can also schedule a convenient time here:\n{{booking_url}}\n\nThank you,\n{{business_name}}",
  followup_1_template:
    "Hi {{first_name}}, just following up regarding your request. We're happy to help with your project. Let us know if you have any questions.\n\n{{business_name}}",
  followup_2_template:
    "Hi {{first_name}}, checking back in on your {{service}} request — still happy to help whenever you're ready. Reply any time or book a slot here:\n{{booking_url}}\n\n{{business_name}}",
  followup_3_template:
    "Hi {{first_name}}, this is our last check-in on your {{service}} request. If timing wasn't right, no worries — reach out whenever you're ready.\n\n{{business_name}}",
  review_request_template:
    "Thanks for choosing {{business_name}}! We hope you're happy with the work.\n\nIf you have a moment, we'd really appreciate a review:\n{{review_url}}\n\n{{business_name}}",
};

const KEYS = Object.keys(DEFAULTS);

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS, ...stored };
  return { ...merged, services: safeParseArray(merged.services) };
}

function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : DEFAULTS.services ? JSON.parse(DEFAULTS.services) : [];
  } catch {
    return JSON.parse(DEFAULTS.services);
  }
}

function updateSettings(partial) {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value'
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (!KEYS.includes(key)) continue;
      const stored = key === 'services' ? JSON.stringify(value) : String(value ?? '');
      upsert.run({ key, value: stored });
    }
  });
  tx(Object.entries(partial));
  return getSettings();
}

function integrationsStatus() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    email: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    calendly: Boolean(process.env.CALENDLY_WEBHOOK_SECRET),
  };
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

module.exports = { getSettings, updateSettings, integrationsStatus, fillTemplate, KEYS };

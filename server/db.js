const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_seconds REAL,
    folder TEXT NOT NULL DEFAULT 'uncategorized',
    slot_key TEXT UNIQUE,
    original_path TEXT NOT NULL,
    optimized_path TEXT,
    thumb_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
  CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at);

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    business_type TEXT NOT NULL,
    details TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_messages(created_at);

  -- ===== DW Lead Machine =====

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    service TEXT NOT NULL,
    description TEXT NOT NULL,
    budget TEXT,
    timeframe TEXT,
    preferred_contact TEXT,
    preferred_appointment_time TEXT,
    status TEXT NOT NULL DEFAULT 'New' CHECK (
      status IN ('New','Contacted','Qualified','Appointment Booked','Quote Sent','Won','Lost','Needs Follow-Up')
    ),
    ai_status TEXT CHECK (ai_status IN ('HOT','WARM','COLD','NEEDS_INFO') OR ai_status IS NULL),
    ai_summary TEXT,
    ai_recommended_action TEXT,
    ai_missing_info TEXT,
    ai_engine TEXT,
    notes TEXT NOT NULL DEFAULT '',
    contacted_at TEXT,
    appointment_booked_at TEXT,
    opted_out INTEGER NOT NULL DEFAULT 0,
    follow_up_stage INTEGER NOT NULL DEFAULT 0,
    unsubscribe_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_ai_status ON leads(ai_status);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_unsub ON leads(unsubscribe_token);

  CREATE TABLE IF NOT EXISTS lead_files (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_lead_files_lead ON lead_files(lead_id);

  CREATE TABLE IF NOT EXISTS lead_events (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

module.exports = db;

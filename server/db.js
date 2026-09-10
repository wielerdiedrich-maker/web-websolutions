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

// ===== DW Laser AI Lead & Quote Assistant =====
// Kept in a separate migration block so existing DW Lead Machine data remains compatible.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    ai_instructions TEXT NOT NULL DEFAULT '',
    notification_email TEXT NOT NULL DEFAULT '',
    tax_rate REAL NOT NULL DEFAULT 0,
    quote_disclaimer TEXT NOT NULL DEFAULT 'Estimated price only. Diedrich will confirm the final price and production details.',
    followups_enabled INTEGER NOT NULL DEFAULT 1,
    followup_delays TEXT NOT NULL DEFAULT '[1,3,7]',
    followup_templates TEXT NOT NULL DEFAULT '["Thanks for contacting DW Laser. We have received your request.","Hi! Just checking in on your custom engraving request. Let us know if you would like to continue.","We still have your DW Laser request saved. We would be happy to help finalize it.","Whenever you are ready, we are here to help with your custom engraving project."]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_products (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Custom engraving',
    base_price REAL,
    engraving_price REAL,
    minimum_quantity INTEGER NOT NULL DEFAULT 1,
    bulk_discount TEXT NOT NULL DEFAULT '[]',
    rush_fee REAL NOT NULL DEFAULT 0,
    production_time TEXT NOT NULL DEFAULT '',
    available_materials TEXT NOT NULL DEFAULT '[]',
    available_colors TEXT NOT NULL DEFAULT '[]',
    engraving_area TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, product_name)
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_products_tenant ON assistant_products(tenant_id, active);
  CREATE TABLE IF NOT EXISTS assistant_customers (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL, company_name TEXT, email TEXT, phone TEXT, opted_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_leads (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES assistant_customers(id), source TEXT NOT NULL DEFAULT 'website',
    product_id TEXT REFERENCES assistant_products(id), product TEXT, quantity INTEGER,
    customization TEXT NOT NULL DEFAULT '', deadline TEXT, artwork_url TEXT, estimated_value REAL,
    lead_score INTEGER NOT NULL DEFAULT 0, lead_status TEXT NOT NULL DEFAULT 'COLD',
    conversation_summary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', last_contact TEXT,
    next_followup TEXT, assigned_to TEXT NOT NULL DEFAULT 'Diedrich', order_status TEXT NOT NULL DEFAULT 'NEW',
    price_snapshot TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_leads_tenant ON assistant_leads(tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assistant_leads_status ON assistant_leads(tenant_id, lead_status);
  CREATE TABLE IF NOT EXISTS assistant_conversations (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id TEXT REFERENCES assistant_leads(id), customer_id TEXT REFERENCES assistant_customers(id),
    channel TEXT NOT NULL DEFAULT 'website', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK(sender IN ('customer','assistant','system','tool')), customer_message TEXT,
    ai_response TEXT, tool_name TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_artwork (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id TEXT REFERENCES assistant_leads(id), conversation_id TEXT REFERENCES assistant_conversations(id),
    original_name TEXT NOT NULL, content_type TEXT NOT NULL, storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_quotes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id TEXT NOT NULL REFERENCES assistant_leads(id) ON DELETE CASCADE, input_snapshot TEXT NOT NULL,
    line_items TEXT NOT NULL, subtotal REAL NOT NULL, tax REAL NOT NULL, estimated_total REAL NOT NULL,
    disclaimer TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_followups (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id TEXT NOT NULL REFERENCES assistant_leads(id) ON DELETE CASCADE, scheduled_for TEXT NOT NULL,
    template TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', attempt_count INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_orders (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id TEXT NOT NULL UNIQUE REFERENCES assistant_leads(id), customer_id TEXT REFERENCES assistant_customers(id),
    order_number TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'NEW', total REAL, production_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assistant_audit_logs (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const tenantId = 'dw-laser';
db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, ?, ?)`).run(tenantId, 'DW Laser', 'dw-laser');
db.prepare(`INSERT OR IGNORE INTO tenant_settings (tenant_id) VALUES (?)`).run(tenantId);
const seedProducts = ['Tumblers','Water bottles','Cutting boards','Leather wallets','Keychains','Slate coasters','Jewelry','Wedding signs','Custom engraving','Corporate gifts','Employee gifts'];
const insertProduct = db.prepare(`INSERT OR IGNORE INTO assistant_products (id, tenant_id, product_name, description, category) VALUES (?, ?, ?, ?, ?)`);
for (const name of seedProducts) insertProduct.run(`product-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, tenantId, name, `Custom ${name.toLowerCase()} engraving by DW Laser.`, name);

module.exports = db;

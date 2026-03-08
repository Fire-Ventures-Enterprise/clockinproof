import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_PUBLISHABLE_KEY?: string
  CLOUDFLARE_API_TOKEN?: string
  CF_ACCOUNT_ID?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use('/api/*', cors())

// ─── Static files ─────────────────────────────────────────────────────────────
// Cache static assets aggressively — files are cache-busted via ?v= query param
app.use('/static/*', async (c, next) => {
  await next()
  // Set long cache for versioned static files (admin.js?v=xxx, worker.js?v=xxx)
  if (c.res.status === 200) {
    c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }
})
app.use('/static/*', serveStatic({ root: './' }))

// ─── Tenant Helper ────────────────────────────────────────────────────────────
// Read subdomain from Host header → return tenant slug
// e.g. "acme.clockinproof.com" → "acme"
// "admin.clockinproof.com" or "app.clockinproof.com" → null (platform URLs)
function getTenantSlug(req: Request): string | null {
  const host = req.headers.get('host') || ''
  const hostname = host.split(':')[0]
  const parts = hostname.split('.')
  // Must be subdomain.clockinproof.com (3 parts)
  if (parts.length < 3) return null
  const sub = parts[0]
  // Platform reserved subdomains
  const reserved = ['admin', 'app', 'www', 'superadmin', 'api', 'mail', 'staging']
  if (reserved.includes(sub)) return null
  return sub
}

// Load tenant by slug — returns null if not found
async function getTenantBySlug(db: D1Database, slug: string) {
  return await db.prepare(`SELECT * FROM tenants WHERE slug = ? AND status != 'deleted'`).bind(slug).first()
}

// Load tenant settings (merged: platform defaults → tenant overrides)
async function getTenantSettings(db: D1Database, tenantId: number): Promise<Record<string, string>> {
  const rows = await db.prepare(`SELECT key, value FROM tenant_settings WHERE tenant_id = ?`).bind(tenantId).all()
  const s: Record<string, string> = {}
  ;(rows.results as any[]).forEach((r: any) => { s[r.key] = r.value })
  return s
}


// ─── Tenant Resolution Helper ─────────────────────────────────────────────────
// Resolves the current tenant from X-Tenant-ID header or subdomain.
// Falls back to tenant 1 ONLY as a last resort (should not happen in production).
async function resolveTenantId(c: any, db: D1Database): Promise<number> {
  const tidHeader = c.req.header('X-Tenant-ID')
  if (tidHeader) {
    const parsed = parseInt(tidHeader)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  const slug = getSubdomain(c)
  if (slug && !['admin','app','www','super','superadmin','api'].includes(slug)) {
    const t = await getTenantBySlug(db, slug) as any
    if (t) return t.id
  }
  return 1
}

// ─── DB Helper ────────────────────────────────────────────────────────────────
// Cache flag: schema only needs to run once per Worker instance (not every request)
// Cloudflare Workers reuse instances across requests — this cuts 40+ SQL statements
// from every API call down to just once on cold start. Massive latency improvement.
let _schemaInitialized = false

async function ensureSchema(db: D1Database) {
  if (_schemaInitialized) return  // ← skip entirely after first run
  _schemaInitialized = true

  // Run each statement individually (D1 exec doesn't support multi-statement)
  const statements = [
    // ── TENANTS (multi-tenant SaaS foundation) ────────────────────────────────
    `CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      company_name TEXT NOT NULL,
      company_address TEXT,
      admin_email TEXT,
      admin_pin TEXT DEFAULT '1234',
      logo_url TEXT,
      primary_color TEXT DEFAULT '#4F46E5',
      plan TEXT DEFAULT 'pro',
      status TEXT DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      trial_ends_at DATETIME,
      max_workers INTEGER DEFAULT 999,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Insert Tenant #1 — 911 Restoration of Ottawa (your company)
    `INSERT OR IGNORE INTO tenants
      (id, slug, company_name, company_address, admin_email, plan, status, max_workers)
     VALUES
      (1, '911restoration-ottawa', '911 Restoration of Ottawa',
       '11 Trustan Court #4, Ottawa, Ontario K2E 8B9',
       'Nasser.o@911restoration.com', 'pro', 'active', 999)`,
    // ── TENANT SETTINGS (per-tenant key/value, mirrors global settings) ───────
    `CREATE TABLE IF NOT EXISTS tenant_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, key),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )`,
    // ── STRIPE PLANS reference table ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS stripe_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stripe_price_id TEXT,
      price_monthly INTEGER NOT NULL,
      max_workers INTEGER NOT NULL,
      features TEXT,
      active INTEGER DEFAULT 1
    )`,
    `INSERT OR IGNORE INTO stripe_plans (id, name, stripe_price_id, price_monthly, max_workers, features) VALUES
      (1, 'Starter', '', 3900, 5, 'GPS clock-in proof,Geofence detection,Auto clock-out,Live GPS map,SMS+email alerts,Payroll reports,Job dispatch,QuickBooks sync')`,
    `INSERT OR IGNORE INTO stripe_plans (id, name, stripe_price_id, price_monthly, max_workers, features) VALUES
      (2, 'Growing Business', '', 5900, 10, 'Everything in Starter,Up to 10 workers,Multi-site management,Accountant export,Worker disputes,Calendar view,Custom branding')`,
    `INSERT OR IGNORE INTO stripe_plans (id, name, stripe_price_id, price_monthly, max_workers, features) VALUES
      (3, 'All Grown Up', '', 7900, 25, 'Everything in Growing Business,Up to 25 workers,White-label branding,Custom logo,Priority support,Encircle integration,Advanced analytics')`,
    `CREATE TABLE IF NOT EXISTS workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      device_id TEXT,
      hourly_rate REAL DEFAULT 0,
      role TEXT DEFAULT 'worker',
      active INTEGER DEFAULT 1,
      pin TEXT DEFAULT '0000',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL,
      clock_in_time DATETIME NOT NULL,
      clock_out_time DATETIME,
      clock_in_lat REAL,
      clock_in_lng REAL,
      clock_in_address TEXT,
      clock_out_lat REAL,
      clock_out_lng REAL,
      clock_out_address TEXT,
      total_hours REAL,
      earnings REAL,
      notes TEXT,
      job_location TEXT,
      job_description TEXT,
      status TEXT DEFAULT 'active',
      drift_flag INTEGER DEFAULT 0,
      drift_distance_meters REAL,
      drift_detected_at DATETIME,
      away_flag INTEGER DEFAULT 0,
      away_since DATETIME,
      auto_clockout INTEGER DEFAULT 0,
      auto_clockout_reason TEXT,
      geofence_exit_time DATETIME,
      geofence_deduction_min REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    // ALTER TABLE is safe to run repeatedly — D1 ignores if column already exists via try/catch in ensureSchema
    `ALTER TABLE sessions ADD COLUMN drift_flag INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN drift_distance_meters REAL`,
    `ALTER TABLE sessions ADD COLUMN drift_detected_at DATETIME`,
    `ALTER TABLE sessions ADD COLUMN away_flag INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN away_since DATETIME`,
    `ALTER TABLE sessions ADD COLUMN auto_clockout INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN auto_clockout_reason TEXT`,
    `ALTER TABLE sessions ADD COLUMN geofence_exit_time DATETIME`,
    `ALTER TABLE sessions ADD COLUMN geofence_deduction_min REAL`,
    `CREATE TABLE IF NOT EXISTS location_pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      worker_id INTEGER NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      accuracy REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    `CREATE TABLE IF NOT EXISTS clock_in_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL,
      worker_name TEXT,
      worker_phone TEXT,
      job_location TEXT NOT NULL,
      job_description TEXT,
      worker_lat REAL,
      worker_lng REAL,
      worker_address TEXT,
      job_lat REAL,
      job_lng REAL,
      distance_meters REAL,
      status TEXT DEFAULT 'pending',
      override_by TEXT,
      override_note TEXT,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'ClockInProof')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('default_hourly_rate', '15.00')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pin', '1234')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('country_code', 'CA')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('province_code', 'ON')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('city', 'Toronto')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Toronto')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('work_start', '08:00')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('work_end', '16:00')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('break_morning_min', '15')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('break_lunch_min', '30')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('break_afternoon_min', '15')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('paid_hours_per_day', '7.5')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('work_days', '1,2,3,4,5')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('stat_pay_multiplier', '1.5')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_email', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('reply_to_email', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('last_weekly_email_sent', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('geofence_radius_meters', '300')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('gps_fraud_check', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_phone', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_email', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_sms', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_account_sid', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_auth_token', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_from_number', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_messaging_service', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('resend_api_key', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('resend_from', 'alerts@clockinproof.com')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('app_host', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_host', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('max_shift_hours', '10')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('away_warning_min', '30')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_clockout_enabled', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('drift_check_enabled', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('drift_radius_meters', '500')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('geofence_exit_clockout_min', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('pay_frequency', 'biweekly')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('pay_period_anchor', '2026-03-06')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('show_pay_to_workers', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('accountant_email', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('company_name', 'ClockInProof')`,
    // ── QuickBooks OAuth integration ──────────────────────────────────────────
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_client_id', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_client_secret', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_realm_id', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_access_token', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_refresh_token', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_token_expires', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_environment', 'production')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_connected', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('qb_company_name', '')`,
    // ── QB worker → QB employee mapping table ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS qb_employee_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL UNIQUE,
      qb_employee_id TEXT NOT NULL,
      qb_employee_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    // ── QB sync log ───────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS qb_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pay_period_start TEXT NOT NULL,
      pay_period_end TEXT NOT NULL,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      worker_count INTEGER DEFAULT 0,
      time_activity_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'success',
      error_message TEXT
    )`,
    // invite_code column on workers (safe to run on existing DBs)
    `ALTER TABLE workers ADD COLUMN invite_code TEXT`,
    // ── Worker profile columns (migration 0004) ───────────────────────────────
    `ALTER TABLE workers ADD COLUMN email TEXT`,
    `ALTER TABLE workers ADD COLUMN home_address TEXT`,
    `ALTER TABLE workers ADD COLUMN job_title TEXT`,
    `ALTER TABLE workers ADD COLUMN start_date TEXT`,
    `ALTER TABLE workers ADD COLUMN pay_type TEXT DEFAULT 'hourly'`,
    `ALTER TABLE workers ADD COLUMN salary_amount REAL DEFAULT 0`,
    `ALTER TABLE workers ADD COLUMN drivers_license_number TEXT`,
    `ALTER TABLE workers ADD COLUMN license_front_b64 TEXT`,
    `ALTER TABLE workers ADD COLUMN license_back_b64 TEXT`,
    `ALTER TABLE workers ADD COLUMN emergency_contact TEXT`,
    `ALTER TABLE workers ADD COLUMN worker_notes TEXT`,
    // ── Feature: worker employment status ────────────────────────────────────
    `ALTER TABLE workers ADD COLUMN worker_status TEXT DEFAULT 'active'`,
    `CREATE TABLE IF NOT EXISTS worker_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id INTEGER NOT NULL,
      changed_by TEXT DEFAULT 'admin',
      old_status TEXT,
      new_status TEXT NOT NULL,
      reason TEXT,
      return_date TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    // ── Feature: session edit audit log ───────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS session_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      edited_by TEXT DEFAULT 'admin',
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      edited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    // ── Feature: saved job sites ──────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS job_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      lat REAL,
      lng REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // ── Feature: worker issue reports ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS session_disputes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      worker_id INTEGER NOT NULL,
      worker_name TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    `ALTER TABLE sessions ADD COLUMN edited INTEGER DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN edit_reason TEXT`,
    // ── session_type: 'regular' | 'material_pickup' | 'emergency_job' ──────────
    // Lets workers flag they are legitimately off-site (pickup, emergency call-out).
    // Geofence check is skipped for these types; admin sees a colored badge.
    `ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'regular'`,
    // ── Material pickup destination + ETA fields ───────────────────────────────
    `ALTER TABLE sessions ADD COLUMN pickup_destination TEXT`,
    `ALTER TABLE sessions ADD COLUMN pickup_eta_minutes INTEGER`,
    // ── Multi-tenant migrations ───────────────────────────────────────────────
    // Add tenant_id to all tables. Safe to run repeatedly — errors caught below.
    `ALTER TABLE workers ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE sessions ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE location_pings ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE clock_in_requests ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE job_sites ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE session_disputes ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE session_edits ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE qb_employee_map ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    `ALTER TABLE qb_sync_log ADD COLUMN tenant_id INTEGER DEFAULT 1`,
    // Migrate all existing data to tenant_id = 1 (911 Restoration of Ottawa)
    `UPDATE workers SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE sessions SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE location_pings SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE clock_in_requests SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE job_sites SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE session_disputes SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE session_edits SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE qb_employee_map SET tenant_id = 1 WHERE tenant_id IS NULL`,
    `UPDATE qb_sync_log SET tenant_id = 1 WHERE tenant_id IS NULL`,
    // Indexes for tenant queries
    `CREATE INDEX IF NOT EXISTS idx_workers_tenant ON workers(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_job_sites_tenant ON job_sites(tenant_id)`,
    // ── Signup Leads — captured at Step 1 before full account creation ────────
    `CREATE TABLE IF NOT EXISTS signup_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      phone TEXT,
      company_name TEXT,
      auth_code TEXT,
      code_expires_at DATETIME,
      code_verified INTEGER DEFAULT 0,
      converted INTEGER DEFAULT 0,
      tenant_id INTEGER,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verified_at DATETIME,
      converted_at DATETIME
    )`,
    `CREATE INDEX IF NOT EXISTS idx_leads_email ON signup_leads(email)`,
    // ── Support Ticket System ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      ticket_number TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'open',
      submitter_name TEXT,
      submitter_email TEXT,
      assigned_to TEXT DEFAULT 'support',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      message TEXT NOT NULL,
      is_internal INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON support_tickets(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON ticket_messages(ticket_id)`,

    // ── Device enforcement (privacy-compliant) ──────────────────────────────
    // device_id is a random browser-generated token stored in localStorage.
    // It is NOT biometric data. It identifies the browser/device session only.
    // Workers give explicit informed consent before it is saved (PIPEDA / CCPA).
    `ALTER TABLE workers ADD COLUMN device_consent_given INTEGER DEFAULT 0`,
    `ALTER TABLE workers ADD COLUMN device_consent_at DATETIME`,
    // ── Feature: temp PIN flow ────────────────────────────────────────────────
    // is_temp_pin = 1 means the PIN was set by admin and worker must change it on first login
    `ALTER TABLE workers ADD COLUMN is_temp_pin INTEGER DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS device_reset_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   INTEGER NOT NULL,
      worker_id   INTEGER NOT NULL,
      worker_name TEXT,
      reason      TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at  DATETIME,
      resolved_by  TEXT,
      new_device_id TEXT,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dev_reset_tenant ON device_reset_requests(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dev_reset_worker ON device_reset_requests(worker_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dev_reset_status ON device_reset_requests(status)`,

    // ── Encircle Integration ──────────────────────────────────────────────────
    `ALTER TABLE job_sites ADD COLUMN encircle_job_id TEXT`,
    `ALTER TABLE job_sites ADD COLUMN encircle_synced_at DATETIME`,
    `ALTER TABLE job_sites ADD COLUMN encircle_status TEXT`,
    `ALTER TABLE encircle_jobs ADD COLUMN manually_closed INTEGER DEFAULT 0`,
    `ALTER TABLE encircle_jobs ADD COLUMN cip_closed_at DATETIME`,
    `ALTER TABLE encircle_jobs ADD COLUMN cip_closed_note TEXT`,
    `ALTER TABLE job_sites ADD COLUMN manually_closed INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS encircle_settings (
      id INTEGER PRIMARY KEY,
      bearer_token TEXT,
      sync_enabled INTEGER DEFAULT 1,
      last_sync_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS encircle_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      jobs_added INTEGER DEFAULT 0,
      jobs_updated INTEGER DEFAULT 0,
      jobs_closed INTEGER DEFAULT 0,
      status TEXT,
      error_message TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_job_sites_encircle ON job_sites(encircle_job_id)`,

    // ── Tax Compliance Module ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS tax_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_charge_id TEXT UNIQUE,
      date TEXT NOT NULL,
      description TEXT,
      usd_amount REAL NOT NULL,
      cad_amount REAL,
      exchange_rate REAL,
      category TEXT DEFAULT 'eci',
      processor TEXT DEFAULT 'stripe',
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      reviewed_by TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tax_exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_date TEXT UNIQUE NOT NULL,
      usd_cad REAL NOT NULL,
      source TEXT DEFAULT 'bankofcanada',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tax_deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_type TEXT NOT NULL,
      due_date TEXT NOT NULL,
      extended_date TEXT,
      fiscal_year INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      filed_date TEXT,
      filed_by TEXT,
      notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tax_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tax_tx_date ON tax_transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_tax_tx_status ON tax_transactions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tax_rates_date ON tax_exchange_rates(rate_date)`,

    // ── Encircle full claim data (contact info, notes, etc.) ─────────────────
    `CREATE TABLE IF NOT EXISTS encircle_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      encircle_claim_id TEXT UNIQUE NOT NULL,
      policyholder_name TEXT,
      policyholder_phone TEXT,
      policyholder_email TEXT,
      full_address TEXT,
      type_of_loss TEXT,
      date_of_loss TEXT,
      date_claim_created TEXT,
      loss_details TEXT,
      project_manager_name TEXT,
      insurer_identifier TEXT,
      insurance_company_name TEXT,
      policy_number TEXT,
      adjuster_name TEXT,
      contractor_identifier TEXT,
      assignment_identifier TEXT,
      emergency_estimate REAL,
      repair_estimate REAL,
      permalink_url TEXT,
      status TEXT DEFAULT 'active',
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      tenant_id INTEGER DEFAULT 1
    )`,
    `CREATE INDEX IF NOT EXISTS idx_encircle_jobs_claim ON encircle_jobs(encircle_claim_id)`,
    `CREATE INDEX IF NOT EXISTS idx_encircle_jobs_tenant ON encircle_jobs(tenant_id)`,

    // ── Job Dispatch ──────────────────────────────────────────────────────────
    // Tracks every job dispatched to a worker via SMS.
    // status flow: sent → replied → arrived → cancelled
    `CREATE TABLE IF NOT EXISTS job_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_site_id INTEGER,
      encircle_claim_id TEXT,
      job_name TEXT NOT NULL,
      job_address TEXT NOT NULL,
      maps_url TEXT,
      worker_id INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      worker_phone TEXT NOT NULL,
      dispatched_by TEXT DEFAULT 'Admin',
      status TEXT DEFAULT 'sent',
      sms_sid TEXT,
      reply_text TEXT,
      reply_at DATETIME,
      arrived_at DATETIME,
      session_id INTEGER,
      notes TEXT,
      tenant_id INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dispatches_worker  ON job_dispatches(worker_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dispatches_status  ON job_dispatches(status)`,
    `CREATE INDEX IF NOT EXISTS idx_dispatches_created ON job_dispatches(created_at)`,
    // ── Tenant profile extras ──────────────────────────────────────────────────
    `ALTER TABLE tenants ADD COLUMN company_phone TEXT`,
    `ALTER TABLE tenants ADD COLUMN company_website TEXT`,
    // ── Archived tenant guardrail (90-day purge) ───────────────────────────────
    `ALTER TABLE tenants ADD COLUMN archived_at DATETIME`,
  ]
  for (const sql of statements) {
    try {
      await db.prepare(sql).run()
    } catch(e: any) {
      // Ignore "duplicate column" errors from ALTER TABLE on re-runs
      // and "no such table" errors when ALTER runs before CREATE (ordering issue)
      if (!e?.message?.includes('duplicate column') &&
          !e?.message?.includes('already exists') &&
          !e?.message?.includes('no such table')) throw e
    }
  }
}

// ─── WORKERS API ──────────────────────────────────────────────────────────────

// Register or get worker by phone
// Privacy note: device_id is a random browser localStorage token — NOT biometric.
// We only record it after the worker gives explicit informed consent on-screen.
app.post('/api/workers/register', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { name, phone: rawPhone, pin, device_id, consent_given } = await c.req.json()
  // Normalize phone: digits only for consistent storage and lookup
  const phone = rawPhone ? rawPhone.replace(/\D/g, '') : rawPhone

  if (!name || !phone) {
    return c.json({ error: 'Name and phone are required' }, 400)
  }
  // Consent is only required when a device_id is being registered (worker's own phone).
  // Admin-side worker creation sends no device_id, so consent check is skipped.
  if (device_id && !consent_given) {
    return c.json({ error: 'consent_required', message: 'Device consent is required to register.' }, 400)
  }

  // Check if worker already exists — try digits-only match against stored phone
  const digitsOnly = phone.replace(/\D/g, '')
  let existing = await db.prepare(
    "SELECT * FROM workers WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ','') = ?"
  ).bind(digitsOnly).first<any>()
  // Also try with leading 1 stripped
  if (!existing && digitsOnly.startsWith('1') && digitsOnly.length === 11) {
    existing = await db.prepare(
      "SELECT * FROM workers WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ','') = ?"
    ).bind(digitsOnly.slice(1)).first<any>()
  }
  if (!existing && !digitsOnly.startsWith('1') && digitsOnly.length === 10) {
    existing = await db.prepare(
      "SELECT * FROM workers WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ','') = ?"
    ).bind('1' + digitsOnly).first<any>()
  }

  if (existing) {
    // ── Admin path: no device_id sent → admin is trying to create a duplicate ──
    // Block it explicitly so the admin UI can show a clear error.
    if (!device_id) {
      return c.json({
        error: 'duplicate_phone',
        message: `Phone number ${phone} is already registered to worker "${existing.name}". Each worker must have a unique phone number.`
      }, 409)
    }

    // ── Worker self-registration path: device_id is present ──
    // Worker exists: if they have no device locked yet, lock this one now (consent already given)
    if (!existing.device_id) {
      await db.prepare(
        `UPDATE workers SET device_id = ?, device_consent_given = 1, device_consent_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(device_id, existing.id).run()
      const updated = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(existing.id).first()
      return c.json({ worker: updated, isNew: false })
    }
    // Device is already locked — verify it matches
    if (existing.device_id !== device_id) {
      return c.json({
        error: 'device_mismatch',
        message: 'This phone number is registered to a different device. If you have a new phone, please contact your manager to reset your device.'
      }, 403)
    }
    // Same device returning — all good
    return c.json({ worker: existing, isNew: false })
  }

  // New worker — create with locked device + consent recorded
  const defaultRate = await db.prepare(
    "SELECT value FROM settings WHERE key = 'default_hourly_rate'"
  ).first<{ value: string }>()

  // is_temp_pin=1 when admin creates worker (no device_id sent), =0 when worker self-registers
  const isTempPin = device_id ? 0 : 1

  const result = await db.prepare(
    `INSERT INTO workers (name, phone, pin, device_id, device_consent_given, device_consent_at, hourly_rate, is_temp_pin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    name,
    phone,
    pin || '0000',
    device_id || null,
    device_id ? 1 : 0,
    device_id ? new Date().toISOString() : null,
    parseFloat(defaultRate?.value || '15'),
    isTempPin
  ).run()

  const worker = await db.prepare(
    'SELECT * FROM workers WHERE id = ?'
  ).bind(result.meta.last_row_id).first()

  return c.json({ worker, isNew: true }, 201)
})

// Lookup worker by phone
// Login: look up worker by phone + enforce device lock
// device_id passed as query param: /api/workers/lookup/:phone?device_id=xxx
// Normalize phone: strip all non-digit characters, then try exact match first,
// then match by stripping leading country code (1 for Canada/US)
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '') // digits only
}

app.get('/api/workers/lookup/:phone', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const rawPhone = decodeURIComponent(c.req.param('phone'))
  const phone    = normalizePhone(rawPhone)
  const deviceId = c.req.query('device_id') || null

  // Try multiple phone formats: digits-only, with country code 1, without leading 1
  const phoneVariants = Array.from(new Set([
    phone,
    phone.startsWith('1') ? phone.slice(1) : '1' + phone,  // toggle leading 1
    '+' + phone,
    '+1' + (phone.startsWith('1') ? phone.slice(1) : phone)
  ]))

  let worker: any = null
  for (const v of phoneVariants) {
    worker = await db.prepare(
      'SELECT * FROM workers WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,"+",""),"-","")," ",""),"(","") = ? AND active = 1'
    ).bind(v.replace(/\D/g, '')).first<any>()
    if (worker) break
  }

  if (!worker) return c.json({ error: 'Worker not found' }, 404)

  // ── Device lock enforcement ──────────────────────────────────────────────
  // Only enforce if worker has a locked device_id on file AND gave consent.
  // Grace: if no device is locked yet, allow login and lock this device now.
  if (worker.device_id && worker.device_consent_given) {
    if (deviceId && worker.device_id !== deviceId) {
      return c.json({
        error: 'device_mismatch',
        message: 'This phone number is registered to a different device. If you have a new phone, please tap "I have a new phone" to request a device reset from your manager.'
      }, 403)
    }
  } else if (!worker.device_id && deviceId) {
    // No device locked yet — lock it now (worker already gave consent during registration)
    await db.prepare(
      `UPDATE workers SET device_id = ?, device_consent_given = 1, device_consent_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(deviceId, worker.id).run()
  }

  // ── PIN verification ────────────────────────────────────────────────────────
  // PIN is required on login. Skip only if worker has never set one (legacy '0000' + no is_temp_pin col).
  const pin = c.req.query('pin') || null
  if (pin !== null) {
    // PIN was provided — verify it
    if (worker.pin && worker.pin !== pin) {
      return c.json({ error: 'wrong_pin', message: 'Incorrect PIN. Please try again.' }, 401)
    }
  }

  // Return safe subset of worker data + is_temp_pin flag so frontend knows to prompt for change
  return c.json({ worker: {
    id: worker.id, name: worker.name, phone: worker.phone,
    hourly_rate: worker.hourly_rate, role: worker.role, active: worker.active,
    is_temp_pin: worker.is_temp_pin ?? 1
  }})
})

// POST /api/workers/:id/change-pin — worker changes their own PIN
app.post('/api/workers/:id/change-pin', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const workerId = parseInt(c.req.param('id'))
  const { current_pin, new_pin } = await c.req.json()

  if (!new_pin || new_pin.length < 4 || new_pin.length > 8 || !/^\d+$/.test(new_pin)) {
    return c.json({ error: 'invalid_pin', message: 'New PIN must be 4–8 numeric digits.' }, 400)
  }

  const worker = await db.prepare('SELECT * FROM workers WHERE id = ? AND active = 1').bind(workerId).first<any>()
  if (!worker) return c.json({ error: 'Worker not found' }, 404)

  // If it was a temp PIN, skip current_pin check (worker doesn't know the admin-set PIN yet)
  if (!worker.is_temp_pin) {
    if (current_pin !== worker.pin) {
      return c.json({ error: 'wrong_pin', message: 'Current PIN is incorrect.' }, 401)
    }
  }

  // Save new PIN and mark as no longer temporary
  await db.prepare(
    `UPDATE workers SET pin = ?, is_temp_pin = 0 WHERE id = ?`
  ).bind(new_pin, workerId).run()

  return c.json({ success: true, message: 'PIN updated successfully.' })
})

// POST /api/workers/forgot-pin — fully automated PIN reset via email (no admin needed)
// Worker enters phone → system generates temp PIN → emails it → worker logs in and sets new PIN
app.post('/api/workers/forgot-pin', async (c) => {
  const db  = c.env.DB
  const env = c.env
  await ensureSchema(db)

  const { phone } = await c.req.json()
  if (!phone) return c.json({ error: 'Phone number is required' }, 400)

  // Look up active worker by phone
  const worker = await db.prepare(
    'SELECT id, name, phone, email FROM workers WHERE phone = ? AND active = 1'
  ).bind(phone).first<any>()

  // Always return success message to prevent phone enumeration attacks
  const safeResponse = c.json({
    success: true,
    message: 'If this phone number is registered, a PIN reset email has been sent.'
  })

  if (!worker) return safeResponse

  // Worker must have an email on file
  if (!worker.email) {
    // No email — still return safe message but log it
    return c.json({
      success: false,
      error: 'no_email',
      message: 'No email address on file. Please contact your manager to reset your PIN.'
    }, 400)
  }

  // Generate a new random 4-digit temp PIN
  const tempPin = String(Math.floor(1000 + Math.random() * 9000))

  // Save temp PIN to DB
  await db.prepare(
    'UPDATE workers SET pin = ?, is_temp_pin = 1 WHERE id = ?'
  ).bind(tempPin, worker.id).run()

  // Get app settings for branding
  const settingsRaw = await db.prepare('SELECT key, value FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })
  const appName = settings.app_name || 'ClockInProof'
  const appHost = (settings.app_host || 'https://app.clockinproof.com').replace(/\/$/, '')
  const joinLink = `\${appHost}/join/\${worker.id}`

  // Send email via Resend
  const resendKey = ((env as any).RESEND_API_KEY || settings.resend_api_key || '').trim()
  if (!resendKey) {
    return c.json({ success: false, error: 'Email service not configured. Contact your manager.' }, 500)
  }

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
    <div style="background:#4f46e5;padding:28px 32px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700">\${appName}</h1>
      <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px">PIN Reset Request</p>
    </div>
    <div style="padding:32px">
      <p style="font-size:15px;color:#374151;margin:0 0 16px">Hi <strong>\${worker.name}</strong>,</p>
      <p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.6">
        We received a request to reset your clock-in PIN. Use the temporary PIN below to log in — you will be asked to create a new personal PIN immediately after.
      </p>
      <div style="background:#f8fafc;border:2px dashed #6366f1;border-radius:14px;padding:24px;text-align:center;margin-bottom:24px">
        <p style="font-size:12px;color:#6b7280;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600">Your Temporary PIN</p>
        <p style="font-size:48px;font-weight:800;color:#4f46e5;letter-spacing:14px;margin:0;font-family:monospace">\${tempPin}</p>
      </div>
      <a href="\${joinLink}" style="display:block;background:#4f46e5;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:10px;font-size:15px;font-weight:700;margin-bottom:20px">
        Open Clock-In App →
      </a>
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px;font-size:12px;color:#92400e;line-height:1.5">
        <strong>⚠️ Security notice:</strong> This PIN expires once you set a new one. If you did not request this reset, please contact your manager immediately.
      </div>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
      <p style="font-size:11px;color:#9ca3af;margin:0">\${appName} · Automated security email · Do not reply</p>
    </div>
  </div>
</body>
</html>`

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer \${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `\${appName} <alerts@clockinproof.com>`,
        to: [worker.email],
        subject: `\${appName} — Your Temporary PIN`,
        html: emailHtml
      })
    })
    const emailData: any = await emailRes.json()
    if (!emailRes.ok) {
      return c.json({ success: false, error: 'Failed to send email. Contact your manager.' }, 500)
    }
    return safeResponse
  } catch (e: any) {
    return c.json({ success: false, error: 'Email delivery failed. Contact your manager.' }, 500)
  }
})

// Get all workers (admin)
app.get('/api/workers', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)

  // Resolve tenant from X-Tenant-ID header or subdomain
  const tidHeader = c.req.header('X-Tenant-ID')
  let tenantId = tidHeader ? parseInt(tidHeader) : null
  if (!tenantId) {
    const slug = getSubdomain(c)
    if (slug && !['admin','app','www','super','superadmin','api'].includes(slug)) {
      const t = await getTenantBySlug(db, slug) as any
      if (t) tenantId = t.id
    }
  }
  if (!tenantId) tenantId = 1  // fallback to tenant 1 (original company)

  const workers = await db.prepare(`
    SELECT w.*,
      COUNT(CASE WHEN s.status = 'active' THEN 1 END) as currently_clocked_in,
      SUM(CASE WHEN s.status = 'completed' THEN s.total_hours ELSE 0 END) as total_hours_all_time,
      SUM(CASE WHEN s.status = 'completed' THEN s.earnings ELSE 0 END) as total_earnings_all_time
    FROM workers w
    LEFT JOIN sessions s ON w.id = s.worker_id
    WHERE w.tenant_id = ?
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).bind(tenantId).all()

  return c.json({ workers: workers.results })
})

// Update worker
app.put('/api/workers/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const body = await c.req.json()

  const {
    name, hourly_rate, role, active,
    email, home_address, job_title, start_date,
    pay_type, salary_amount,
    drivers_license_number, license_front_b64, license_back_b64,
    emergency_contact, worker_notes, pin
  } = body

  await db.prepare(`
    UPDATE workers SET
      name = ?,
      hourly_rate = ?,
      role = ?,
      active = ?,
      email = ?,
      home_address = ?,
      job_title = ?,
      start_date = ?,
      pay_type = ?,
      salary_amount = ?,
      drivers_license_number = ?,
      license_front_b64 = COALESCE(NULLIF(?, ''), license_front_b64),
      license_back_b64  = COALESCE(NULLIF(?, ''), license_back_b64),
      emergency_contact = ?,
      worker_notes = ?
      ${pin !== undefined ? ', pin = ?' : ''}
    WHERE id = ?
  `).bind(
    name, hourly_rate ?? 0, role ?? 'worker', active ?? 1,
    email ?? null, home_address ?? null, job_title ?? null, start_date ?? null,
    pay_type ?? 'hourly', salary_amount ?? 0,
    drivers_license_number ?? null,
    license_front_b64 ?? '',
    license_back_b64  ?? '',
    emergency_contact ?? null, worker_notes ?? null,
    ...(pin !== undefined ? [pin] : []),
    id
  ).run()

  const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(id).first()
  return c.json({ worker })
})

// Delete worker
app.delete('/api/workers/:id', async (c) => {
  const db  = c.env.DB
  const id  = parseInt(c.req.param('id'))

  // Check for active sessions — block delete if worker is currently clocked in
  const activeSession = await db.prepare(
    "SELECT id FROM sessions WHERE worker_id = ? AND status = 'active'"
  ).bind(id).first<any>()
  if (activeSession) {
    return c.json({ error: 'Worker is currently clocked in. Clock them out first before deleting.' }, 409)
  }

  // Cascade delete all related data in order (FK safe)
  await db.prepare('DELETE FROM worker_status_log WHERE worker_id = ?').bind(id).run()
  await db.prepare('DELETE FROM qb_employee_map WHERE worker_id = ?').bind(id).run()
  await db.prepare('DELETE FROM clock_in_requests WHERE worker_id = ?').bind(id).run()
  await db.prepare('DELETE FROM location_pings WHERE worker_id = ?').bind(id).run()
  await db.prepare('DELETE FROM session_edits WHERE session_id IN (SELECT id FROM sessions WHERE worker_id = ?)').bind(id).run()
  await db.prepare('DELETE FROM session_disputes WHERE session_id IN (SELECT id FROM sessions WHERE worker_id = ?)').bind(id).run()
  await db.prepare('DELETE FROM sessions WHERE worker_id = ?').bind(id).run()
  await db.prepare('DELETE FROM workers WHERE id = ?').bind(id).run()

  return c.json({ success: true })
})

// ─── WORKER STATUS & AUDIT TRAIL API ─────────────────────────────────────────

// GET /api/workers/:id/status — get current status + full audit trail
app.get('/api/workers/:id/status', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = parseInt(c.req.param('id'))

  const worker = await db.prepare(
    'SELECT id, name, active, worker_status FROM workers WHERE id = ?'
  ).bind(id).first<any>()
  if (!worker) return c.json({ error: 'Worker not found' }, 404)

  // Derive current status: if active=0 and no worker_status, it's 'terminated'
  const currentStatus = worker.worker_status || (worker.active ? 'active' : 'terminated')

  const logRaw = await db.prepare(
    'SELECT * FROM worker_status_log WHERE worker_id = ? ORDER BY changed_at DESC LIMIT 100'
  ).bind(id).all<any>()

  return c.json({ worker_id: id, current_status: currentStatus, log: logRaw.results || [] })
})

// POST /api/workers/:id/status — change worker employment status
app.post('/api/workers/:id/status', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  await ensureSchema(db)
  const id   = parseInt(c.req.param('id'))
  const body = await c.req.json().catch(() => ({})) as any

  const newStatus  = (body.status || '').trim().toLowerCase()
  const reason     = (body.reason || '').trim()
  const returnDate = (body.return_date || '').trim()
  const changedBy  = (body.changed_by || 'admin').trim()

  const validStatuses = ['active', 'on_holiday', 'sick_leave', 'suspended', 'terminated']
  if (!validStatuses.includes(newStatus)) {
    return c.json({ error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') }, 400)
  }
  if (!reason) return c.json({ error: 'A reason is required when changing worker status.' }, 400)

  const worker = await db.prepare(
    'SELECT id, name, active, worker_status FROM workers WHERE id = ?'
  ).bind(id).first<any>()
  if (!worker) return c.json({ error: 'Worker not found' }, 404)

  const oldStatus = worker.worker_status || (worker.active ? 'active' : 'terminated')

  // Update workers table — sync active flag
  const isActive = newStatus === 'active' || newStatus === 'on_holiday' || newStatus === 'sick_leave' ? 1 : 0
  await db.prepare(
    'UPDATE workers SET worker_status = ?, active = ? WHERE id = ?'
  ).bind(newStatus, isActive, id).run()

  // Write audit log entry
  await db.prepare(
    `INSERT INTO worker_status_log (worker_id, changed_by, old_status, new_status, reason, return_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, changedBy, oldStatus, newStatus, reason, returnDate || null).run()

  // If suspended or terminated — force clock out any active session
  if (newStatus === 'suspended' || newStatus === 'terminated') {
    const activeSession = await db.prepare(
      "SELECT s.*, w.hourly_rate, w.name as worker_name, w.phone as worker_phone FROM sessions s JOIN workers w ON s.worker_id=w.id WHERE s.worker_id=? AND s.status='active'"
    ).bind(id).first<any>()

    if (activeSession) {
      const now        = new Date()
      const clockInMs  = new Date(activeSession.clock_in_time).getTime()
      const hoursWorked = (now.getTime() - clockInMs) / (1000 * 60 * 60)
      const earnings    = hoursWorked * (activeSession.hourly_rate || 0)
      const autoReason  = newStatus === 'terminated'
        ? `Worker terminated — auto clocked out by admin`
        : `Worker suspended: ${reason}`

      await db.prepare(`
        UPDATE sessions SET clock_out_time=?, total_hours=?, earnings=?,
          status='completed', auto_clockout=1, auto_clockout_reason=?
        WHERE id=?
      `).bind(now.toISOString(), Math.round(hoursWorked*100)/100, Math.round(earnings*100)/100, autoReason, activeSession.id).run()

      // Notify worker via SMS
      const settingsRaw = await db.prepare('SELECT * FROM settings').all()
      const settings: Record<string, string> = {}
      ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })
      const appName = settings.app_name || 'ClockInProof'

      const smsMap: Record<string, string> = {
        suspended: `⚠️ ${appName}: Your account has been suspended.\nReason: ${reason}\nContact your manager for details.`,
        terminated: `🔴 ${appName}: Your employment has been recorded as terminated.\nReason: ${reason}\nContact your manager for details.`
      }
      if (activeSession.worker_phone && smsMap[newStatus]) {
        await sendWorkerSms(env, activeSession.worker_phone, smsMap[newStatus])
      }
    }
  }

  const logRaw = await db.prepare(
    'SELECT * FROM worker_status_log WHERE worker_id = ? ORDER BY changed_at DESC LIMIT 100'
  ).bind(id).all<any>()

  return c.json({ success: true, worker_id: id, old_status: oldStatus, new_status: newStatus, log: logRaw.results || [] })
})

// ─── SESSIONS API (Clock In / Out) ────────────────────────────────────────────

// ─── WORKER JOIN LINK API (no codes needed) ───────────────────────────────────

// GET /api/workers/:id/invite  — return worker's join link info
app.get('/api/workers/:id/invite', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = parseInt(c.req.param('id'))
  const worker = await db.prepare('SELECT id, name, phone FROM workers WHERE id = ? AND active = 1').bind(id).first() as any
  if (!worker) return c.json({ error: 'Worker not found' }, 404)
  const appHost   = 'https://app.clockinproof.com'
  const joinLink  = `${appHost}/join/${worker.id}`
  return c.json({ worker_id: worker.id, worker_name: worker.name, worker_phone: worker.phone, join_link: joinLink, is_active: true })
})

// POST /api/workers/:id/invite  — kept for compatibility, just returns the join link
app.post('/api/workers/:id/invite', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = parseInt(c.req.param('id'))
  const worker = await db.prepare('SELECT id, name, phone FROM workers WHERE id = ? AND active = 1').bind(id).first() as any
  if (!worker) return c.json({ error: 'Worker not found' }, 404)
  const appHost  = 'https://app.clockinproof.com'
  const joinLink = `${appHost}/join/${worker.id}`
  return c.json({ invite_code: String(worker.id), worker_name: worker.name, worker_phone: worker.phone, invite_link: joinLink, join_link: joinLink })
})

// DELETE /api/workers/:id/invite  — no-op kept for compatibility
app.delete('/api/workers/:id/invite', async (c) => {
  return c.json({ success: true, message: 'Links cannot be revoked (use Terminate worker status instead)' })
})

// GET /api/workers/join/:id  — returns worker data by numeric ID (used by /join page)
app.get('/api/workers/join/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = parseInt(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'Invalid worker ID' }, 400)
  const worker = await db.prepare(
    'SELECT id, name, phone, hourly_rate, role, active, worker_status FROM workers WHERE id = ? AND active = 1'
  ).bind(id).first() as any
  if (!worker) return c.json({ error: 'Worker not found or no longer active' }, 404)
  // Block suspended/terminated workers from logging in via link
  const blocked = ['suspended', 'terminated']
  if (blocked.includes(worker.worker_status || '')) {
    return c.json({ error: 'Your access has been suspended. Contact your manager.' }, 403)
  }
  return c.json({ worker })
})

// POST /api/workers/:id/invite/send-sms  — send join link via Twilio
app.post('/api/workers/:id/invite/send-sms', async (c) => {
  const db  = c.env.DB
  const env = c.env
  await ensureSchema(db)
  const id = parseInt(c.req.param('id'))

  const worker = await db.prepare('SELECT id, name, phone, pin, is_temp_pin FROM workers WHERE id = ?').bind(id).first() as any
  if (!worker) return c.json({ error: 'Worker not found' }, 404)

  // Get Twilio credentials
  const twilioSid     = ((env as any).TWILIO_ACCOUNT_SID      || '').trim()
  const twilioToken   = ((env as any).TWILIO_AUTH_TOKEN        || '').trim()
  const twilioMsgSvc  = ((env as any).TWILIO_MESSAGING_SERVICE || '').trim()
  const twilioFrom    = ((env as any).TWILIO_FROM_NUMBER       || '').trim()

  const dbSettings = await db.prepare("SELECT key, value FROM settings WHERE key IN ('twilio_account_sid','twilio_auth_token','twilio_from_number','twilio_messaging_service','app_host')").all()
  const cfg: Record<string,string> = {}
  ;(dbSettings.results as any[]).forEach((r: any) => { cfg[r.key] = r.value })

  const sid    = twilioSid    || cfg.twilio_account_sid       || ''
  const token  = twilioToken  || cfg.twilio_auth_token        || ''
  const msgSvc = twilioMsgSvc || cfg.twilio_messaging_service || ''
  const from   = twilioFrom   || cfg.twilio_from_number       || ''

  if (!sid || !token || (!msgSvc && !from)) {
    return c.json({ error: 'Twilio not configured — add credentials in Settings', twilio_missing: true }, 400)
  }

  const appHost  = cfg.app_host ? cfg.app_host.replace(/\/$/, '') : 'https://app.clockinproof.com'
  const joinLink = `${appHost}/join/${worker.id}`

  // Include temp PIN in SMS if worker hasn't changed it yet
  const pinLine = worker.is_temp_pin
    ? `\nYour temporary PIN: ${worker.pin}\n(You will be asked to create your own PIN on first login.)\n`
    : ''

  const smsBody =
    `Hi ${worker.name}! 👋\n` +
    `Your ClockInProof clock-in app is ready.\n` +
    `Tap this link to get started:\n` +
    `${joinLink}` +
    pinLine +
    `\nBookmark it or add to your Home Screen for quick access.`

  // Normalize phone to E.164
  const rawPhone    = worker.phone.replace(/[\s\-\(\)\.]/g, '')
  const workerPhone = rawPhone.startsWith('+') ? rawPhone
    : rawPhone.length === 10 ? `+1${rawPhone}` : `+${rawPhone}`

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
  const auth      = btoa(`${sid}:${token}`)

  try {
    const smsRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(
        msgSvc ? { MessagingServiceSid: msgSvc, To: workerPhone, Body: smsBody }
               : { From: from,               To: workerPhone, Body: smsBody }
      ).toString()
    })
    const smsData = await smsRes.json() as any
    if (smsRes.ok && smsData.sid) {
      return c.json({ success: true, message_sid: smsData.sid, sent_to: workerPhone, invite_link: joinLink })
    } else {
      return c.json({ error: smsData.message || 'Twilio returned an error', twilio_code: smsData.code, twilio_status: smsRes.status }, 400)
    }
  } catch(e: any) {
    return c.json({ error: `SMS send failed: ${e.message}` }, 500)
  }
})

// GET /api/workers/by-invite/:code  — legacy redirect (kept so old links don't 404)
app.get('/api/workers/by-invite/:code', async (c) => {
  return c.json({ error: 'This is an old-format link. Please ask your manager to resend your invite.' }, 410)
})

// GET /invite/:code  — legacy redirect to /join flow
app.get('/invite/:code', async (c) => {
  // Old invite links: try to find worker by invite_code and redirect to /join/:id
  const db   = c.env.DB
  const code = c.req.param('code').toUpperCase()
  const worker = await db.prepare(
    'SELECT id FROM workers WHERE invite_code = ? AND active = 1'
  ).bind(code).first() as any
  if (worker) {
    return c.redirect(`/join/${worker.id}`, 301)
  }
  // Code not found — show helpful error page
  return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>ClockInProof</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#1e40af;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:24px;padding:40px 32px;text-align:center;max-width:360px;width:100%}.icon{font-size:48px;margin-bottom:16px}h1{font-size:20px;font-weight:700;color:#1e3a8a;margin-bottom:8px}p{color:#6b7280;font-size:15px;line-height:1.5}</style>
    </head><body><div class="card"><div class="icon">🔗</div>
    <h1>Link Expired</h1>
    <p>This link is no longer valid.<br>Please ask your manager to send you a new link.</p>
    </div></body></html>`)
})

// GET /join/:workerId  — NEW clean join page (no codes, no API call needed for display)
app.get('/join/:workerId', async (c) => {
  const workerIdRaw = c.req.param('workerId')
  const workerId    = parseInt(workerIdRaw)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
  <meta name="theme-color" content="#1e40af"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
  <meta name="apple-mobile-web-app-title" content="ClockInProof"/>
  <title>ClockInProof — Opening App...</title>
  <link rel="manifest" href="/static/manifest-worker.json"/>
  <link rel="apple-touch-icon" href="/static/icon-192.png"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;background:#1e40af;min-height:100vh;
      display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:24px;padding:40px 28px;text-align:center;
      max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25)}
    .icon{width:80px;height:80px;background:#1e40af;border-radius:50%;
      display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:36px}
    h1{font-size:22px;font-weight:700;color:#1e3a8a;margin-bottom:8px}
    .spinner{width:44px;height:44px;border:4px solid #e0e7ff;border-top-color:#1e40af;
      border-radius:50%;animation:spin 0.8s linear infinite;margin:16px auto}
    @keyframes spin{to{transform:rotate(360deg)}}
    .name{font-size:22px;font-weight:700;color:#1e3a8a;margin:16px 0 6px}
    .sub{color:#6b7280;font-size:15px;margin-bottom:24px}
    .btn{display:block;width:100%;padding:16px;background:#1e40af;color:#fff;
      font-size:17px;font-weight:700;border:none;border-radius:14px;
      cursor:pointer;text-decoration:none;margin-top:10px;letter-spacing:.01em}
    .btn:active{background:#1d4ed8}
    .error-box{background:#fef2f2;border:1.5px solid #fca5a5;border-radius:14px;
      padding:16px;color:#dc2626;font-size:14px;line-height:1.6;margin-top:16px}
    .install-box{background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;
      padding:14px;margin-top:14px;font-size:13px;color:#0369a1;line-height:1.7;text-align:left}
  </style>
</head>
<body>
<div class="card" id="card">
  <div class="icon">⏱</div>
  <h1>ClockInProof</h1>
  <p style="color:#6b7280;font-size:15px;margin-bottom:8px">Opening your app&hellip;</p>
  <div class="spinner" id="spinner"></div>
  <div id="msg" style="display:none"></div>
</div>
<script>
(async () => {
  const workerId = ${isNaN(workerId) ? 'null' : workerId}
  const spinner  = document.getElementById('spinner')
  const msg      = document.getElementById('msg')

  if (!workerId) {
    spinner.style.display = 'none'
    msg.style.display = 'block'
    msg.innerHTML = '<div class="error-box"><strong>❌ Invalid link.</strong><br>Please ask your manager to send you a new link.</div>'
    return
  }

  try {
    const res  = await fetch('/api/workers/join/' + workerId)
    const data = await res.json()

    if (!res.ok || !data.worker) {
      spinner.style.display = 'none'
      msg.style.display = 'block'
      const errText = data.error || 'Link not working. Please contact your manager.'
      msg.innerHTML = '<div class="error-box"><strong>❌ ' + errText + '</strong></div>'
      return
    }

    const w = data.worker
    // ── DO NOT auto-login here ──
    // Just store the worker ID as a hint for the app, then send them to /app
    // The app will handle: consent → register/login → temp PIN change
    // This prevents bypassing the PIN and consent flows
    localStorage.setItem('wt_join_worker_id', String(w.id))
    localStorage.setItem('wt_join_phone', w.phone || '')
    // Clear any stale wt_worker so the app shows the login screen fresh
    localStorage.removeItem('wt_worker')

    // Show success + open app button
    spinner.style.display = 'none'
    msg.style.display = 'block'
    msg.innerHTML = \`
      <p class="name">👋 Hi, \${w.name}!</p>
      <p class="sub">Tap below to open your clock-in app and get started.</p>
      <a href="/app" class="btn">📲 Open ClockInProof</a>
      <div class="install-box" id="install-hint">
        <strong>📌 Save to your Home Screen</strong><br>
        Tap your browser's <strong>Share → Add to Home Screen</strong> button.<br>
        After that, just tap the ClockInProof icon — no link needed!
      </div>
    \`
    // Auto-redirect in 2s
    setTimeout(() => { window.location.href = '/app' }, 2000)

  } catch(e) {
    spinner.style.display = 'none'
    msg.style.display = 'block'
    msg.innerHTML = \`
      <div class="error-box">
        <strong>⚠️ Could not connect.</strong><br>
        Check your internet and <a href="javascript:location.reload()" style="color:#1e40af;font-weight:600;">tap here to try again</a>.
      </div>
    \`
  }
})()
</script>
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  });
}
let deferredInstallPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  window._pwaReady = true;
});
window.showPwaInstall = function() {
  const hint = document.getElementById('install-hint');
  if (!hint) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) { hint.style.display = 'none'; return; }
  if (deferredInstallPrompt) {
    hint.innerHTML = \`<strong>📲 Install App on Your Phone</strong><br>
      <button id="pwa-do-install" style="margin-top:10px;background:#1d4ed8;color:white;border:none;padding:12px 24px;border-radius:10px;font-size:15px;font-weight:700;width:100%;cursor:pointer;">
        ➕ Add ClockInProof to Home Screen</button>
      <p style="margin-top:8px;font-size:11px;color:#64748b;">Tap once — no App Store needed</p>\`;
    document.getElementById('pwa-do-install').onclick = async () => {
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      if (outcome === 'accepted') hint.innerHTML = '<strong>✅ App installed!</strong>';
    };
  } else if (isIOS) {
    hint.innerHTML = \`<strong>📲 Add to Home Screen (iPhone/iPad)</strong><br>
      <ol style="text-align:left;margin:10px 0 0;padding-left:18px;line-height:2;">
        <li>Tap the <strong>Share</strong> button ⬆️ in Safari</li>
        <li>Tap <strong>"Add to Home Screen"</strong></li>
        <li>Tap <strong>"Add"</strong> — done!</li>
      </ol>\`;
  }
}
</script>
</body>
</html>`
  return c.html(html)
})

// Haversine distance in meters between two lat/lng points
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000  // Earth radius in metres
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// Geocode a free-text address → { lat, lng } using Nominatim (free, no key)
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; display: string } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`
    const res = await fetch(url, { headers: { 'User-Agent': 'ClockInProof/1.0', 'Accept': 'application/json' } })
    if (!res.ok) return null
    const data: any[] = await res.json()
    if (!data || data.length === 0) return null
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name }
  } catch { return null }
}

// ─── OVERRIDE NOTIFICATION HELPER ────────────────────────────────────────────
// Sends email (Resend) and/or SMS (Twilio) to admin when a worker is blocked.
// Both channels are optional and configured in Settings.
// The notification contains a deep-link directly to /admin#overrides so the
// admin can tap the message on any device and land straight on the approval card.
async function sendOverrideNotification(
  settings: Record<string, string>,
  env: any,
  req: {
    id: number
    worker_name: string
    worker_phone: string
    job_location: string
    job_description: string
    distance_meters: number
    worker_address: string | null
    worker_lat: number | null
    worker_lng: number | null
  }
): Promise<{ emailSent: boolean; smsSent: boolean; errors: string[] }> {
  const result = { emailSent: false, smsSent: false, errors: [] as string[] }

  const appName    = settings.app_name    || 'ClockInProof'
  const adminEmail = settings.admin_email || ''
  const adminPhone = settings.admin_phone || ''
  const notifyEmail = settings.notify_email !== '0'
  const notifySms   = settings.notify_sms  === '1'

  const distM   = Math.round(req.distance_meters || 0)
  const distTxt = distM >= 1000 ? (distM / 1000).toFixed(1) + ' km' : distM + ' m'

  // Deep-link URL → opens admin dashboard at the Overrides tab
  // Uses admin_host setting (admin.clockinproof.com) if configured, else app_host, else relative
  const adminHost = (await env.DB.prepare(`SELECT value FROM settings WHERE key='admin_host'`).first<{value:string}>())?.value || ''
  const appHost   = adminHost || env.APP_HOST || ''   // fallback chain
  const deepLink  = appHost ? `${appHost}/admin#overrides` : '/admin#overrides'
  const approveLink = appHost ? `${appHost}/admin#overrides` : '/admin#overrides'

  const workerMapLink = (req.worker_lat && req.worker_lng)
    ? `https://www.google.com/maps?q=${req.worker_lat},${req.worker_lng}`
    : null

  // ── EMAIL via Resend ────────────────────────────────────────────────────────
  // Credentials: Cloudflare env secret first, DB fallback for local dev
  const resendKey  = (env.RESEND_API_KEY || settings.resend_api_key || '').trim()
  const resendFrom = (env.RESEND_FROM    || settings.resend_from    || `${appName} Alerts <alerts@clockinproof.com>`).trim()
  if (notifyEmail && adminEmail && resendKey) {
    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#dc2626;border-radius:16px 16px 0 0;padding:24px;text-align:center;">
      <div style="font-size:36px;margin-bottom:8px;">🛡️</div>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Clock-In Blocked</h1>
      <p style="color:#fca5a5;margin:6px 0 0;font-size:14px;">Admin approval required — GPS mismatch detected</p>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">

      <!-- Worker info -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr>
          <td style="padding:10px;background:#fef2f2;border-radius:10px 0 0 10px;width:50%;">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;">Worker</p>
            <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#111827;">${req.worker_name}</p>
            <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${req.worker_phone}</p>
          </td>
          <td style="padding:10px;background:#fef2f2;border-radius:0 10px 10px 0;border-left:4px solid #dc2626;">
            <p style="margin:0;font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;">Distance from job site</p>
            <p style="margin:4px 0 0;font-size:22px;font-weight:800;color:#dc2626;">${distTxt}</p>
            <p style="margin:2px 0 0;font-size:12px;color:#6b7280;">away from "${req.job_location}"</p>
          </td>
        </tr>
      </table>

      <!-- Location comparison -->
      <div style="background:#f9fafb;border-radius:12px;padding:16px;margin-bottom:20px;">
        <p style="margin:0 0 12px;font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.5px;">Location Comparison</p>
        <div style="margin-bottom:12px;">
          <p style="margin:0;font-size:12px;color:#6b7280;">📍 <strong>Worker's actual GPS location</strong></p>
          <p style="margin:4px 0 0;font-size:13px;color:#111827;">${req.worker_address || 'Unknown address'}</p>
          ${workerMapLink ? `<a href="${workerMapLink}" style="font-size:12px;color:#3b82f6;">View on Google Maps →</a>` : ''}
        </div>
        <div style="border-top:1px solid #e5e7eb;padding-top:12px;">
          <p style="margin:0;font-size:12px;color:#6b7280;">🏗️ <strong>Job site entered by worker</strong></p>
          <p style="margin:4px 0 0;font-size:13px;color:#111827;">${req.job_location}</p>
        </div>
      </div>

      <!-- Task -->
      <div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:0 8px 8px 0;padding:12px;margin-bottom:24px;">
        <p style="margin:0;font-size:12px;color:#6b7280;">📋 <strong>Task description</strong></p>
        <p style="margin:4px 0 0;font-size:13px;color:#1e40af;">${req.job_description || 'Not specified'}</p>
      </div>

      <!-- CTA Button -->
      <div style="text-align:center;margin-bottom:20px;">
        <a href="${deepLink}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 40px;border-radius:12px;letter-spacing:.3px;">
          👉 Review &amp; Approve / Deny
        </a>
        <p style="margin:12px 0 0;font-size:12px;color:#9ca3af;">Tap the button — opens the Overrides tab directly on any device</p>
      </div>

      <!-- Info note -->
      <div style="background:#ffffbf;border:1px solid #fde68a;border-radius:8px;padding:12px;font-size:12px;color:#92400e;">
        <strong>Note:</strong> The worker is waiting on their phone and will be automatically clocked in the moment you approve, or shown a denial message if you deny.
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">${appName} · Override Request #${req.id} · ${new Date().toLocaleString()}</p>
      <p style="margin:6px 0 0;font-size:11px;color:#d1d5db;">Sent to ${adminEmail}</p>
    </div>
  </div>
</body>
</html>`

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: resendFrom,
          to: [adminEmail],
          subject: `🚨 [${appName}] Clock-In Blocked: ${req.worker_name} is ${distTxt} from "${req.job_location}"`,
          html: emailHtml
        })
      })
      if (emailRes.ok) {
        result.emailSent = true
      } else {
        const errData = await emailRes.json() as any
        result.errors.push(`Email failed: ${errData?.message || emailRes.status}`)
      }
    } catch (e: any) {
      result.errors.push(`Email error: ${e.message}`)
    }
  }

  // ── SMS via Twilio ──────────────────────────────────────────────────────────
  // Credentials: prefer Cloudflare env secrets, fall back to DB settings (local dev)
  const twilioSid    = (env.TWILIO_ACCOUNT_SID      || settings.twilio_account_sid       || '').trim()
  const twilioToken  = (env.TWILIO_AUTH_TOKEN        || settings.twilio_auth_token        || '').trim()
  const twilioMsgSvc = (env.TWILIO_MESSAGING_SERVICE || settings.twilio_messaging_service || '').trim()
  const twilioFrom   = (env.TWILIO_FROM_NUMBER       || settings.twilio_from_number       || '').trim()

  if (notifySms && adminPhone && twilioSid && twilioToken && (twilioMsgSvc || twilioFrom)) {
    const smsBody =
      `🚨 ${appName} ALERT\n` +
      `Worker ${req.worker_name} tried to clock in but is ${distTxt} from "${req.job_location}".\n` +
      `Task: ${(req.job_description || '').substring(0, 60)}\n` +
      `Tap to approve/deny: ${approveLink}`

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`
    const twilioAuth = btoa(`${twilioSid}:${twilioToken}`)

    try {
      const smsRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${twilioAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(
          twilioMsgSvc
            ? { MessagingServiceSid: twilioMsgSvc, To: adminPhone.startsWith('+') ? adminPhone : `+${adminPhone}`, Body: smsBody }
            : { From: twilioFrom,                  To: adminPhone.startsWith('+') ? adminPhone : `+${adminPhone}`, Body: smsBody }
        ).toString()
      })
      if (smsRes.ok) {
        result.smsSent = true
      } else {
        const errData = await smsRes.json() as any
        result.errors.push(`SMS failed: ${errData?.message || smsRes.status}`)
      }
    } catch (e: any) {
      result.errors.push(`SMS error: ${e.message}`)
    }
  }

  return result
}

// Clock In — with GPS fraud detection
app.post('/api/sessions/clock-in', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { worker_id, latitude, longitude, address, notes, job_location, job_description, session_type, device_id, job_site_id, pickup_destination, pickup_return_to, pickup_eta_minutes } = await c.req.json()

  if (!worker_id) return c.json({ error: 'worker_id required' }, 400)
  if (!job_location || !job_location.trim()) return c.json({ error: 'Job location is required' }, 400)
  if (!job_description || !job_description.trim()) return c.json({ error: 'Job description is required' }, 400)

  // Normalize session type early — needed for device lock bypass logic below
  const validTypes = ['regular', 'material_pickup', 'emergency_job']
  const clockType = validTypes.includes(session_type) ? session_type : 'regular'

  // ── Device lock enforcement on clock-in ──────────────────────────────────
  // Prevents buddy punching: verifies the clock-in is coming from the
  // device registered by this worker. Not biometric — random browser token.
  // EXCEPTION: material_pickup and emergency_job are legitimately done from
  // a PC or different device (supply store, office, emergency call) — allow
  // those session types to bypass the device lock.
  const workerRow = await db.prepare('SELECT * FROM workers WHERE id = ? AND active = 1').bind(parseInt(worker_id)).first<any>()
  if (!workerRow) return c.json({ error: 'Worker not found or inactive', message: 'Your worker account was not found. Please sign out and sign in again at your company subdomain (e.g. yourcompany.clockinproof.com).' }, 404)

  const isOffSiteType = clockType === 'material_pickup' || clockType === 'emergency_job'
  if (!isOffSiteType && workerRow.device_id && workerRow.device_consent_given && device_id && workerRow.device_id !== device_id) {
    return c.json({
      error: 'device_mismatch',
      message: 'Clock-in blocked: this is not the registered device for this worker. If you have a new phone, ask your manager to reset your device.'
    }, 403)
  }

  // Check if already clocked in
  const already = await db.prepare(
    "SELECT * FROM sessions WHERE worker_id = ? AND status = 'active'"
  ).bind(worker_id).first()
  if (already) return c.json({ error: 'Already clocked in', session: already }, 409)

  // Load settings
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const fraudCheckEnabled = settings.gps_fraud_check !== '0'
  const geofenceRadius    = parseFloat(settings.geofence_radius_meters || '300')

  // ── GPS FRAUD CHECK ──────────────────────────────────────────────────────────
  // Skip geofence check for Material Pickup and Emergency Job — worker is
  // legitimately off-site. Admin is notified via the session type badge instead.
  const skipGeofence = clockType === 'material_pickup' || clockType === 'emergency_job'

  if (fraudCheckEnabled && latitude && longitude && !skipGeofence) {
    // ── GPS FRAUD CHECK v2: Compare worker GPS against admin-configured job sites ──
    // This is CHEAT-PROOF: workers cannot bypass it by typing a fake address.
    // The check uses coordinates stored by the admin in the job_sites table.
    // If no job sites are configured, fall back to geocoding the typed address.

    const jobSitesResult = await db.prepare(
      'SELECT * FROM job_sites WHERE active = 1 AND tenant_id = 1 ORDER BY id'
    ).all<any>()
    const jobSites = (jobSitesResult.results || []) as any[]

    let closestSite: any = null
    let closestDistanceM = Infinity

    if (jobSites.length > 0) {
      // Find the job site closest to the worker's current GPS
      for (const site of jobSites) {
        if (site.lat && site.lng) {
          const d = haversineMeters(latitude, longitude, parseFloat(site.lat), parseFloat(site.lng))
          if (d < closestDistanceM) {
            closestDistanceM = d
            closestSite = site
          }
        }
      }
    }

    // Determine which coords to compare against:
    // Priority 1 — job site selected by worker (passed as job_site_id in request)
    // Priority 2 — closest configured job site
    // Priority 3 — geocode the typed address (fallback only, less reliable)
    let checkSite = closestSite
    if (job_site_id) {
      const selected = jobSites.find((s: any) => s.id === parseInt(job_site_id))
      if (selected) checkSite = selected
    }

    let jobCoords: { lat: number; lng: number; display: string } | null = null
    let usingJobSite = false

    if (checkSite && checkSite.lat && checkSite.lng) {
      jobCoords = { lat: parseFloat(checkSite.lat), lng: parseFloat(checkSite.lng), display: checkSite.address || checkSite.name }
      usingJobSite = true
    } else {
      // No job sites configured — fall back to geocoding the typed address
      jobCoords = await geocodeAddress(job_location.trim())
    }

    if (jobCoords) {
      const distanceM = haversineMeters(latitude, longitude, jobCoords.lat, jobCoords.lng)
      const distanceKm = (distanceM / 1000).toFixed(2)

      if (distanceM > geofenceRadius) {
        // ── FRAUD DETECTED ────────────────────────────────────────────────────
        const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(worker_id).first<any>()

        const reqResult = await db.prepare(`
          INSERT INTO clock_in_requests
            (worker_id, worker_name, worker_phone, job_location, job_description,
             worker_lat, worker_lng, worker_address,
             job_lat, job_lng, distance_meters, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).bind(
          worker_id,
          worker?.name || '',
          worker?.phone || '',
          usingJobSite ? (checkSite.name + ' — ' + (checkSite.address || '')) : job_location.trim(),
          job_description.trim(),
          latitude, longitude, address || null,
          jobCoords.lat, jobCoords.lng,
          Math.round(distanceM)
        ).run()

        const requestId = reqResult.meta.last_row_id

        sendOverrideNotification(settings, c.env as any, {
          id: requestId as number,
          worker_name: worker?.name || '',
          worker_phone: worker?.phone || '',
          job_location: usingJobSite ? (checkSite.name + ' — ' + (checkSite.address || '')) : job_location.trim(),
          job_description: job_description.trim(),
          distance_meters: Math.round(distanceM),
          worker_address: address || null,
          worker_lat: latitude,
          worker_lng: longitude
        }).catch(() => {})

        const siteLabel = usingJobSite
          ? `job site "${checkSite.name}" (${checkSite.address || ''})`
          : `"${job_location}"`

        return c.json({
          error: 'location_mismatch',
          blocked: true,
          request_id: requestId,
          message: `Your GPS location is ${distanceKm} km away from ${siteLabel}. Clock-in blocked.`,
          worker_location: { lat: latitude, lng: longitude, address: address || null },
          job_location_coords: { lat: jobCoords.lat, lng: jobCoords.lng, address: jobCoords.display },
          distance_km: distanceKm,
          distance_meters: Math.round(distanceM),
          geofence_radius_meters: geofenceRadius,
          override_pending: true,
          override_message: 'An override request has been sent to your manager. You may only clock in after approval.'
        }, 403)
      }
      // Worker is within geofence — proceed
    }
    // If no coords available — allow clock-in (fail open, log warning)
  }

  // ── NORMAL CLOCK IN ──────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const result = await db.prepare(
    `INSERT INTO sessions
     (worker_id, clock_in_time, clock_in_lat, clock_in_lng, clock_in_address, notes, job_location, job_description, status, session_type, pickup_destination, pickup_eta_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(
    worker_id, now, latitude || null, longitude || null, address || null,
    notes || null, job_location.trim(), job_description.trim(), clockType,
    clockType === 'material_pickup' ? (pickup_destination || null) : null,
    clockType === 'material_pickup' ? (pickup_eta_minutes || null) : null
  ).run()

  const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(result.meta.last_row_id).first()

  // ── Mark any open dispatch for this worker as "arrived" ──────────────────
  try {
    await db.prepare(`
      UPDATE job_dispatches
      SET status='arrived', arrived_at=datetime('now'), session_id=?
      WHERE worker_id=? AND status IN ('sent','replied')
      AND date(created_at) >= date('now','-1 day')
    `).bind(result.meta.last_row_id, worker_id).run()
  } catch(_) { /* non-fatal */ }

  return c.json({ session, message: 'Clocked in successfully' }, 201)
})

// Clock Out
app.post('/api/sessions/clock-out', async (c) => {
  const db = c.env.DB
  const { worker_id, latitude, longitude, address, notes } = await c.req.json()

  if (!worker_id) return c.json({ error: 'worker_id required' }, 400)

  // Get active session
  const session = await db.prepare(
    "SELECT s.*, w.hourly_rate FROM sessions s JOIN workers w ON s.worker_id = w.id WHERE s.worker_id = ? AND s.status = 'active'"
  ).bind(worker_id).first<any>()

  if (!session) {
    return c.json({ error: 'No active session found' }, 404)
  }

  const now = new Date()
  const clockIn = new Date(session.clock_in_time)
  const totalHours = (now.getTime() - clockIn.getTime()) / (1000 * 60 * 60)
  const earnings = totalHours * (session.hourly_rate || 0)

  await db.prepare(
    `UPDATE sessions SET 
      clock_out_time = ?,
      clock_out_lat = ?,
      clock_out_lng = ?,
      clock_out_address = ?,
      total_hours = ?,
      earnings = ?,
      status = 'completed',
      notes = COALESCE(?, notes)
     WHERE id = ?`
  ).bind(
    now.toISOString(),
    latitude || null,
    longitude || null,
    address || null,
    Math.round(totalHours * 100) / 100,
    Math.round(earnings * 100) / 100,
    notes || null,
    session.id
  ).run()

  const updated = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(session.id).first()
  return c.json({ session: updated, total_hours: totalHours, earnings, message: 'Clocked out successfully' })
})

// ─── CLOCK-IN OVERRIDE REQUESTS ──────────────────────────────────────────────

// Worker polls this to check if their override request was approved/denied
app.get('/api/override/status/:request_id', async (c) => {
  const db = c.env.DB
  const req = await db.prepare(
    'SELECT * FROM clock_in_requests WHERE id = ?'
  ).bind(c.req.param('request_id')).first<any>()

  if (!req) return c.json({ error: 'Request not found' }, 404)
  return c.json({ request: req })
})

// Worker checks if they have a pending override request
app.get('/api/override/worker/:worker_id', async (c) => {
  const db = c.env.DB
  const req = await db.prepare(
    "SELECT * FROM clock_in_requests WHERE worker_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1"
  ).bind(c.req.param('worker_id')).first<any>()
  return c.json({ request: req || null })
})

// Admin: get all pending override requests
app.get('/api/override/pending', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const requests = await db.prepare(
    "SELECT * FROM clock_in_requests WHERE status = 'pending' AND tenant_id = ? ORDER BY requested_at DESC"
  ).bind(tenantId).all()
  return c.json({ requests: requests.results })
})

// Admin: get all override requests (history)
app.get('/api/override/all', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const requests = await db.prepare(
    "SELECT * FROM clock_in_requests WHERE tenant_id = ? ORDER BY requested_at DESC LIMIT 100"
  ).bind(tenantId).all()
  return c.json({ requests: requests.results })
})

// Admin: approve override → actually clock the worker in
app.post('/api/override/:id/approve', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const { admin_note } = await c.req.json().catch(() => ({} as any))

  const req = await db.prepare('SELECT * FROM clock_in_requests WHERE id = ?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Request not found' }, 404)
  if (req.status !== 'pending') return c.json({ error: 'Request already resolved' }, 409)

  // Check not already clocked in
  const already = await db.prepare(
    "SELECT id FROM sessions WHERE worker_id = ? AND status = 'active'"
  ).bind(req.worker_id).first()
  if (already) {
    await db.prepare(
      "UPDATE clock_in_requests SET status='denied', override_note='Already clocked in', resolved_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(id).run()
    return c.json({ error: 'Worker is already clocked in' }, 409)
  }

  // Create the session
  const now = new Date().toISOString()
  const sessionResult = await db.prepare(`
    INSERT INTO sessions
      (worker_id, clock_in_time, clock_in_lat, clock_in_lng, clock_in_address,
       job_location, job_description, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).bind(
    req.worker_id, now,
    req.worker_lat, req.worker_lng, req.worker_address,
    req.job_location, req.job_description,
    `ADMIN OVERRIDE — Worker was ${Math.round(req.distance_meters)}m from job site. ${admin_note || ''}`
  ).run()

  const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionResult.meta.last_row_id).first()

  // Mark request approved
  await db.prepare(
    "UPDATE clock_in_requests SET status='approved', override_by='admin', override_note=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(admin_note || 'Approved by admin', id).run()

  return c.json({ success: true, session, message: 'Override approved — worker clocked in' })
})

// Admin: deny override
app.post('/api/override/:id/deny', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const { admin_note } = await c.req.json().catch(() => ({} as any))

  const req = await db.prepare('SELECT * FROM clock_in_requests WHERE id = ?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Request not found' }, 404)
  if (req.status !== 'pending') return c.json({ error: 'Request already resolved' }, 409)

  await db.prepare(
    "UPDATE clock_in_requests SET status='denied', override_by='admin', override_note=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(admin_note || 'Denied by admin', id).run()

  return c.json({ success: true, message: 'Override denied' })
})

// Admin: manually re-send notification for a pending request
app.post('/api/override/:id/notify', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  const id  = c.req.param('id')
  await ensureSchema(db)

  const req = await db.prepare('SELECT * FROM clock_in_requests WHERE id = ?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Request not found' }, 404)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const result = await sendOverrideNotification(settings, env, {
    id: req.id,
    worker_name: req.worker_name,
    worker_phone: req.worker_phone,
    job_location: req.job_location,
    job_description: req.job_description,
    distance_meters: req.distance_meters,
    worker_address: req.worker_address,
    worker_lat: req.worker_lat,
    worker_lng: req.worker_lng
  })

  return c.json({
    success: true,
    email_sent: result.emailSent,
    sms_sent: result.smsSent,
    errors: result.errors
  })
})

// ── HELPER: Send SMS via platform Twilio ─────────────────────────────────────
// Credentials priority: Cloudflare env secrets → DB settings (local dev fallback)
async function sendWorkerSms(
  env: any,
  workerPhone: string,
  message: string
): Promise<{ sent: boolean; error?: string }> {
  try {
    // 1. Try env secrets first (production)
    let sid    = (env.TWILIO_ACCOUNT_SID      || '').trim()
    let token  = (env.TWILIO_AUTH_TOKEN       || '').trim()
    let msgSvc = (env.TWILIO_MESSAGING_SERVICE|| '').trim()
    let from   = (env.TWILIO_FROM_NUMBER      || '').trim()

    // 2. Fall back to DB settings (local dev / first-run)
    if (!sid || !token) {
      const db = env.DB
      const settingsRaw = await db.prepare("SELECT key, value FROM settings WHERE key IN ('twilio_account_sid','twilio_auth_token','twilio_from_number','twilio_messaging_service')").all()
      const s: Record<string, string> = {}
      ;(settingsRaw.results as any[]).forEach((r: any) => { s[r.key] = r.value })
      if (!sid)    sid    = (s.twilio_account_sid       || '').trim()
      if (!token)  token  = (s.twilio_auth_token        || '').trim()
      if (!msgSvc) msgSvc = (s.twilio_messaging_service || '').trim()
      if (!from)   from   = (s.twilio_from_number       || '').trim()
    }

    if (!sid || !token || (!msgSvc && !from)) {
      return { sent: false, error: 'Twilio not configured — add credentials in Super Admin → Platform Settings' }
    }

    const rawPhone = workerPhone.replace(/[\s\-\(\)\.]/g, '')
    const toPhone  = rawPhone.startsWith('+') ? rawPhone : `+1${rawPhone}`

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
    const auth      = btoa(`${sid}:${token}`)
    const body      = new URLSearchParams(
      msgSvc
        ? { MessagingServiceSid: msgSvc, To: toPhone, Body: message }
        : { From: from,                  To: toPhone, Body: message }
    )

    const res  = await fetch(twilioUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    const data = await res.json() as any
    if (res.ok && data.sid) return { sent: true }
    return { sent: false, error: data.message || `Twilio error ${res.status}` }
  } catch (e: any) {
    return { sent: false, error: e?.message || 'Unknown error' }
  }
}

// ── SEND ADMIN SMS ────────────────────────────────────────────────────────────
// Sends an SMS to the admin phone number configured in settings
async function sendAdminSms(
  settings: Record<string, string>,
  env: any,
  message: string
): Promise<{ sent: boolean; error?: string }> {
  const adminPhone = (settings.admin_phone || '').trim()
  if (!adminPhone) return { sent: false, error: 'No admin phone configured' }
  return sendWorkerSms(env, adminPhone, message)
}

// ── ADMIN FORCE CLOCK-OUT: stop any single active session ────────────────────
app.post('/api/sessions/:id/admin-clockout', async (c) => {
  const db      = c.env.DB
  const env     = c.env as any
  const id      = parseInt(c.req.param('id'))
  const body    = await c.req.json().catch(() => ({})) as any
  const adminNote = body.note?.trim() || 'Manually stopped by admin'

  await ensureSchema(db)

  const session = await db.prepare(
    "SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate FROM sessions s JOIN workers w ON s.worker_id=w.id WHERE s.id=? AND s.status='active'"
  ).bind(id).first<any>()

  if (!session) return c.json({ error: 'Session not found or already completed' }, 404)

  const now        = new Date()
  const clockInMs  = new Date(session.clock_in_time).getTime()
  const hoursWorked = (now.getTime() - clockInMs) / (1000 * 60 * 60)
  const earnings    = hoursWorked * (session.hourly_rate || 0)
  // Store clean note only — no prefix, no duplication into notes field
  const reason = adminNote

  await db.prepare(`
    UPDATE sessions SET
      clock_out_time=?, total_hours=?, earnings=?,
      status='completed', auto_clockout=1, auto_clockout_reason=?
    WHERE id=?
  `).bind(
    now.toISOString(),
    Math.round(hoursWorked * 100) / 100,
    Math.round(earnings * 100) / 100,
    reason, id
  ).run()

  // Fetch settings for notifications
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const appName   = settings.app_name || 'ClockInProof'
  const appHost   = settings.app_host || 'https://app.clockinproof.com'
  const hrsFormatted = `${Math.floor(hoursWorked)}h ${Math.round((hoursWorked % 1) * 60)}m`

  // ── Notify worker via SMS ──────────────────────────────────────────────────
  let workerSmsResult = { sent: false, error: 'No phone' }
  if (session.worker_phone) {
    const smsMsg =
      `⏹ ${appName}: You have been clocked out by your manager.\n` +
      `Reason: ${adminNote}\n` +
      `Hours worked: ${hrsFormatted}\n` +
      `If you have questions, contact your manager.`
    workerSmsResult = await sendWorkerSms(env, session.worker_phone, smsMsg)
  }

  return c.json({
    success: true,
    message: `${session.worker_name} clocked out by admin`,
    session_id: id,
    total_hours: Math.round(hoursWorked * 100) / 100,
    earnings: Math.round(earnings * 100) / 100,
    reason,
    worker_notified: workerSmsResult.sent,
    worker_sms_error: workerSmsResult.error
  })
})

// ── ADMIN BULK CLOCK-OUT: stop all sessions where worker left geofence ────────
app.post('/api/sessions/clockout-drifted', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  const body = await c.req.json().catch(() => ({})) as any
  const adminNote = body.note?.trim() || 'Worker left job site — stopped by admin'

  await ensureSchema(db)

  // Get all active drifted sessions
  const drifted = await db.prepare(`
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id=w.id
    WHERE s.status='active' AND s.drift_flag=1
  `).all()

  if (!drifted.results || drifted.results.length === 0)
    return c.json({ success: true, message: 'No drifted sessions to close', count: 0 })

  const now = new Date()
  const stopped: any[] = []

  for (const s of drifted.results as any[]) {
    const clockInMs  = new Date((s as any).clock_in_time).getTime()
    const hoursWorked = (now.getTime() - clockInMs) / (1000 * 60 * 60)
    const earnings    = hoursWorked * ((s as any).hourly_rate || 0)
    const distKmStr = ((s as any).drift_distance_meters / 1000).toFixed(1)
    const reason = `Left job site (${distKmStr}km from site)`

    await db.prepare(`
      UPDATE sessions SET
        clock_out_time=?, total_hours=?, earnings=?,
        status='completed', auto_clockout=1, auto_clockout_reason=?
      WHERE id=?
    `).bind(
      now.toISOString(),
      Math.round(hoursWorked * 100) / 100,
      Math.round(earnings * 100) / 100,
      reason, (s as any).id
    ).run()

    // Notify worker via SMS
    if ((s as any).worker_phone) {
      const hrsF = `${Math.floor(hoursWorked)}h ${Math.round((hoursWorked % 1) * 60)}m`
      const distKm = ((s as any).drift_distance_meters / 1000).toFixed(1)
      const smsMsg =
        `⚠️ ClockInProof: You have been automatically clocked out.\n` +
        `Reason: You were detected ${distKm}km outside the job site geofence.\n` +
        `Hours recorded: ${hrsF}\n` +
        `If this is an error, contact your manager.`
      await sendWorkerSms(env, (s as any).worker_phone, smsMsg)
    }

    stopped.push({
      session_id: (s as any).id,
      worker_name: (s as any).worker_name,
      hours: Math.round(hoursWorked * 10) / 10,
      earnings: Math.round(earnings * 100) / 100
    })
  }

  return c.json({
    success: true,
    message: `${stopped.length} worker(s) clocked out`,
    count: stopped.length,
    sessions: stopped
  })
})

// Get current session status for a worker
app.get('/api/sessions/status/:worker_id', async (c) => {
  const db = c.env.DB
  const worker_id = c.req.param('worker_id')

  const active = await db.prepare(
    "SELECT * FROM sessions WHERE worker_id = ? AND status = 'active'"
  ).bind(worker_id).first()

  return c.json({ active_session: active || null, is_clocked_in: !!active })
})

// Get sessions for a worker
app.get('/api/sessions/worker/:worker_id', async (c) => {
  const db = c.env.DB
  const worker_id = c.req.param('worker_id')
  const limit = c.req.query('limit') || '30'

  const sessions = await db.prepare(
    `SELECT * FROM sessions WHERE worker_id = ? ORDER BY created_at DESC LIMIT ?`
  ).bind(worker_id, parseInt(limit)).all()

  return c.json({ sessions: sessions.results })
})

// Get all active sessions (admin dashboard)
app.get('/api/sessions/active', async (c) => {
  const db = c.env.DB
  const tenantId = await resolveTenantId(c, db)

  const sessions = await db.prepare(`
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE s.status = 'active' AND s.tenant_id = ?
    ORDER BY s.clock_in_time DESC
  `).bind(tenantId).all()

  return c.json({ sessions: sessions.results })
})

// Get all sessions with filters (admin)
app.get('/api/sessions', async (c) => {
  const db = c.env.DB
  const tenantId = await resolveTenantId(c, db)
  const date = c.req.query('date') // YYYY-MM-DD
  const worker_id = c.req.query('worker_id')
  const limit = c.req.query('limit') || '100'

  let query = `
    SELECT s.*, w.name as worker_name, w.phone as worker_phone
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE s.tenant_id = ?
  `
  const params: any[] = [tenantId]

  if (date) {
    query += ` AND DATE(s.clock_in_time) = ?`
    params.push(date)
  }

  if (worker_id) {
    query += ` AND s.worker_id = ?`
    params.push(parseInt(worker_id))
  }

  query += ` ORDER BY s.clock_in_time DESC LIMIT ?`
  params.push(parseInt(limit))

  const sessions = await db.prepare(query).bind(...params).all()
  return c.json({ sessions: sessions.results })
})

// GET /api/sessions/last/:worker_id — fetch most recent completed session (for clockout reason)
app.get('/api/sessions/last/:worker_id', async (c) => {
  const db = c.env.DB
  const worker_id = c.req.param('worker_id')
  const session = await db.prepare(
    `SELECT id, auto_clockout, auto_clockout_reason, clock_out_time, total_hours
     FROM sessions WHERE worker_id = ? AND status = 'completed'
     ORDER BY clock_out_time DESC LIMIT 1`
  ).bind(parseInt(worker_id)).first<any>()
  if (!session) return c.json({ error: 'No completed session found' }, 404)
  return c.json(session)
})

// ─── LOCATION PINGS API ───────────────────────────────────────────────────────

app.post('/api/location/ping', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  const { session_id, worker_id, latitude, longitude, accuracy } = await c.req.json()

  if (!session_id || !worker_id || !latitude || !longitude) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  // Record the ping
  await db.prepare(
    `INSERT INTO location_pings (session_id, worker_id, latitude, longitude, accuracy)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(session_id, worker_id, latitude, longitude, accuracy || null).run()

  // ── DRIFT CHECK ──────────────────────────────────────────────────────────────
  // Compare current GPS against the job site — flag if worker has left
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const driftCheckEnabled = settings.drift_check_enabled !== '0'
  const driftRadius = parseFloat(settings.drift_radius_meters || '500')

  let driftDetected = false
  let driftDistanceM = 0

  if (driftCheckEnabled) {
    const session = await db.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).bind(session_id).first<any>()

    if (session && session.job_location && !session.drift_flag) {
      // Geocode the job site (we stored job_lat/lng in clock_in if fraud-checked,
      // so try those first before calling Nominatim again)
      let jobLat = session.clock_in_lat
      let jobLng = session.clock_in_lng

      // If clock-in coords are the worker's GPS (not job coords), geocode the address
      if (!jobLat || !jobLng) {
        const jobCoords = await geocodeAddress(session.job_location)
        if (jobCoords) { jobLat = jobCoords.lat; jobLng = jobCoords.lng }
      }

      if (jobLat && jobLng) {
        driftDistanceM = haversineMeters(latitude, longitude, jobLat, jobLng)
        if (driftDistanceM > driftRadius) {
          driftDetected = true
          const now = new Date().toISOString()
          await db.prepare(
            `UPDATE sessions SET drift_flag=1, drift_distance_meters=?, drift_detected_at=? WHERE id=?`
          ).bind(Math.round(driftDistanceM), now, session_id).run()

          // Send admin notification about drift (email via sendOverrideNotification + direct SMS)
          const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(worker_id).first<any>()
          const distStr = driftDistanceM >= 1000
            ? (driftDistanceM / 1000).toFixed(1) + 'km'
            : Math.round(driftDistanceM) + 'm'
          sendOverrideNotification(settings, env, {
            id: session_id as number,
            worker_name: worker?.name || 'Worker',
            worker_phone: worker?.phone || '',
            job_location: session.job_location,
            job_description: `⚠️ LOCATION DRIFT: Worker has left the job site during their shift. Currently ${Math.round(driftDistanceM)}m away from "${session.job_location}". Original task: ${session.job_description || 'N/A'}`,
            distance_meters: Math.round(driftDistanceM),
            worker_address: null,
            worker_lat: latitude,
            worker_lng: longitude
          }).catch(() => {})
          // Also send a direct SMS to admin
          if (settings.notify_sms === '1') {
            const exitMin = parseFloat(settings.geofence_exit_clockout_min || '0')
            const autoMsg = exitMin > 0 ? ` Will auto clock-out in ${exitMin} min if still away.` : ' Go to admin dashboard to clock out.'
            sendAdminSms(settings, env,
              `⚠️ ClockInProof: ${worker?.name || 'Worker'} LEFT the job site.\n` +
              `Distance: ${distStr} from "${session.job_location}".\n` +
              `${autoMsg}\n` +
              `View live: ${settings.admin_host || 'https://admin.clockinproof.com'}/#live`
            ).catch(() => {})
          }
        }
      }
    }
  }

  return c.json({
    success: true,
    drift_detected: driftDetected,
    drift_distance_meters: driftDetected ? Math.round(driftDistanceM) : null
  })
})

// ── WATCHDOG: check all active sessions for away + auto-clockout ───────────────
// Called by worker app every minute AND can be triggered server-side
app.get('/api/sessions/watchdog', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  await ensureSchema(db)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const maxShiftHours    = parseFloat(settings.max_shift_hours    || '10')
  const awayWarningMin   = parseFloat(settings.away_warning_min   || '30')
  const autoClockoutOn   = settings.auto_clockout_enabled !== '0'
  const workEnd          = settings.work_end || '16:00'

  const activeSessions = await db.prepare(`
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE s.status = 'active'
  `).all()

  const now     = new Date()
  const nowMs   = now.getTime()
  const results: any[] = []

  for (const s of activeSessions.results as any[]) {
    const clockInMs   = new Date(s.clock_in_time).getTime()
    const hoursWorked = (nowMs - clockInMs) / (1000 * 60 * 60)
    const item: any   = { session_id: s.id, worker_name: s.worker_name, worker_phone: s.worker_phone }

    // ── 1. MAX SHIFT AUTO-CLOCKOUT ───────────────────────────────────────────
    if (autoClockoutOn && hoursWorked >= maxShiftHours && !s.auto_clockout) {
      const reason = `Auto clocked out after ${maxShiftHours}h max shift limit`
      const earnings = hoursWorked * (s.hourly_rate || 0)
      await db.prepare(`
        UPDATE sessions SET
          clock_out_time=?, total_hours=?, earnings=?,
          status='completed', auto_clockout=1, auto_clockout_reason=?
        WHERE id=?
      `).bind(now.toISOString(), Math.round(hoursWorked*100)/100, Math.round(earnings*100)/100, reason, s.id).run()
      item.action = 'auto_clocked_out'
      item.reason = reason
      item.hours  = Math.round(hoursWorked*10)/10

      // Notify worker via SMS
      if (s.worker_phone) {
        const hrsF = `${Math.floor(hoursWorked)}h ${Math.round((hoursWorked % 1) * 60)}m`
        await sendWorkerSms(env, s.worker_phone,
          `⏹ ClockInProof: You have been automatically clocked out.\nReason: You reached the ${maxShiftHours}h maximum shift limit.\nHours recorded: ${hrsF}\nIf this is an error, contact your manager.`
        ).catch(() => {})
      }

      // Notify admin (email via sendOverrideNotification + direct SMS)
      sendOverrideNotification(settings, env, {
        id: s.id,
        worker_name: s.worker_name,
        worker_phone: s.worker_phone,
        job_location: s.job_location || 'Unknown',
        job_description: `🕐 AUTO CLOCK-OUT: Worker exceeded ${maxShiftHours}h max shift. Session automatically closed at ${now.toLocaleTimeString()}. Hours recorded: ${item.hours}h. Original task: ${s.job_description || 'N/A'}`,
        distance_meters: 0,
        worker_address: null,
        worker_lat: null,
        worker_lng: null
      }).catch(() => {})
      if (settings.notify_sms === '1') {
        sendAdminSms(settings, env,
          `⏹ ClockInProof AUTO CLOCK-OUT\n${s.worker_name} was clocked out — reached ${maxShiftHours}h max shift.\nHours: ${item.hours}h\nSite: ${s.job_location || 'Unknown'}\nView: ${settings.admin_host || 'https://admin.clockinproof.com'}/#sessions`
        ).catch(() => {})
      }

      results.push(item)
      continue
    }

    // ── 2. END-OF-DAY AUTO-CLOCKOUT ──────────────────────────────────────────
    // If still clocked in 30 min after work_end, auto clock out at work_end time
    if (autoClockoutOn && !s.auto_clockout) {
      const [endH, endM] = workEnd.split(':').map(Number)
      const todayEnd = new Date(now)
      todayEnd.setHours(endH, endM, 0, 0)
      const graceMs = 30 * 60 * 1000  // 30-minute grace
      if (nowMs > todayEnd.getTime() + graceMs && clockInMs < todayEnd.getTime()) {
        // Clock out AT work_end, not now (to be fair to the worker)
        const workHours = (todayEnd.getTime() - clockInMs) / (1000 * 60 * 60)
        const earnings  = workHours * (s.hourly_rate || 0)
        const reason    = `Auto clocked out at end of day (${workEnd}) — no clock-out recorded`
        await db.prepare(`
          UPDATE sessions SET
            clock_out_time=?, total_hours=?, earnings=?,
            status='completed', auto_clockout=1, auto_clockout_reason=?
          WHERE id=?
        `).bind(todayEnd.toISOString(), Math.round(workHours*100)/100, Math.round(earnings*100)/100, reason, s.id).run()
        item.action = 'auto_clocked_out_eod'
        item.reason = reason
        item.hours  = Math.round(workHours*10)/10

        // Notify worker via SMS
        if (s.worker_phone) {
          const hrsF = `${Math.floor(workHours)}h ${Math.round((workHours % 1) * 60)}m`
          await sendWorkerSms(env, s.worker_phone,
            `🌙 ClockInProof: You forgot to clock out.\nYou have been automatically clocked out at end of day (${workEnd}).\nHours recorded: ${hrsF}\nIf this is an error, contact your manager.`
          ).catch(() => {})
        }

        sendOverrideNotification(settings, env, {
          id: s.id,
          worker_name: s.worker_name,
          worker_phone: s.worker_phone,
          job_location: s.job_location || 'Unknown',
          job_description: `🌙 END-OF-DAY AUTO CLOCK-OUT: Worker forgot to clock out. Session closed at ${workEnd}. Hours recorded: ${item.hours}h. Task: ${s.job_description || 'N/A'}`,
          distance_meters: 0,
          worker_address: null,
          worker_lat: null,
          worker_lng: null
        }).catch(() => {})
        if (settings.notify_sms === '1') {
          sendAdminSms(settings, env,
            `🌙 ClockInProof AUTO CLOCK-OUT\n${s.worker_name} forgot to clock out. Clocked out at end of day (${workEnd}).\nHours: ${item.hours}h\nSite: ${s.job_location || 'Unknown'}\nView: ${settings.admin_host || 'https://admin.clockinproof.com'}/#sessions`
          ).catch(() => {})
        }

        results.push(item)
        continue
      }
    }

    // ── 3. GEOFENCE EXIT AUTO-CLOCKOUT ────────────────────────────────────────
    // If worker has been outside the geofence for geofence_exit_clockout_min minutes,
    // automatically clock them out (0 = disabled).
    // Clock-out time is set to drift_detected_at + exitClockoutMin so the worker
    // is charged exactly the grace period — not any extra time they wandered.
    const exitClockoutMin = parseFloat(settings.geofence_exit_clockout_min || '0')
    if (exitClockoutMin > 0 && s.drift_flag && !s.auto_clockout && s.drift_detected_at) {
      const driftDetectedAt = new Date(s.drift_detected_at)
      const driftMs      = nowMs - driftDetectedAt.getTime()
      const driftMinutes = driftMs / (1000 * 60)
      if (driftMinutes >= exitClockoutMin) {
        // Clock-out exactly at drift_detected_at + exitClockoutMin (fair deduction)
        const clockOutAt   = new Date(driftDetectedAt.getTime() + exitClockoutMin * 60 * 1000)
        const paidHours    = (clockOutAt.getTime() - clockInMs) / (1000 * 60 * 60)
        const earnings     = Math.max(0, paidHours) * (s.hourly_rate || 0)
        const dist = s.drift_distance_meters >= 1000
          ? (s.drift_distance_meters / 1000).toFixed(1) + 'km'
          : Math.round(s.drift_distance_meters || 0) + 'm'
        // Reason includes the full timeline for the record
        const exitTimeStr      = driftDetectedAt.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true })
        const clockOutTimeStr  = clockOutAt.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true })
        const reason = `Auto clocked out — left geofence at ${exitTimeStr} (${dist} from site), ${exitClockoutMin}min grace period, clocked out at ${clockOutTimeStr}. Hours paid: ${Math.max(0,Math.round(paidHours*100)/100)}h`
        await db.prepare(`
          UPDATE sessions SET
            clock_out_time=?, total_hours=?, earnings=?,
            status='completed', auto_clockout=1, auto_clockout_reason=?,
            geofence_exit_time=?, geofence_deduction_min=?
          WHERE id=?
        `).bind(
          clockOutAt.toISOString(),
          Math.max(0, Math.round(paidHours*100)/100),
          Math.max(0, Math.round(earnings*100)/100),
          reason,
          driftDetectedAt.toISOString(),   // exact time worker left geofence
          exitClockoutMin,                  // minutes of grace/deduction recorded
          s.id
        ).run()
        item.action           = 'auto_clocked_out_drift'
        item.reason           = reason
        item.hours            = Math.max(0, Math.round(paidHours*10)/10)
        item.geofence_exit_time = driftDetectedAt.toISOString()
        item.deduction_min    = exitClockoutMin
        item.clock_out_at     = clockOutAt.toISOString()

        // Notify worker via SMS
        if (s.worker_phone) {
          const hrsF = `${Math.floor(Math.max(0,paidHours))}h ${Math.round(((Math.max(0,paidHours)) % 1) * 60)}m`
          await sendWorkerSms(env, s.worker_phone,
            `📍 ClockInProof: You were automatically clocked out.\n` +
            `You left the job site at ${exitTimeStr} (${dist} from "${s.job_location || 'site'}").\n` +
            `After ${exitClockoutMin}min grace period, your clock-out was recorded at ${clockOutTimeStr}.\n` +
            `Hours paid: ${hrsF}\n` +
            `If this is an error, tap the app to submit a dispute.`
          ).catch(() => {})
        }

        sendOverrideNotification(settings, env, {
          id: s.id,
          worker_name: s.worker_name,
          worker_phone: s.worker_phone,
          job_location: s.job_location || 'Unknown',
          job_description: `📍 GEOFENCE AUTO CLOCK-OUT: ${s.worker_name} left the site at ${exitTimeStr} (${dist} away). After ${exitClockoutMin}min grace, clocked out at ${clockOutTimeStr}. Hours paid: ${item.hours}h. Task: ${s.job_description || 'N/A'}`,
          distance_meters: s.drift_distance_meters || 0,
          worker_address: null,
          worker_lat: null,
          worker_lng: null
        }).catch(() => {})
        if (settings.notify_sms === '1') {
          sendAdminSms(settings, env,
            `📍 AUTO CLOCK-OUT — ${s.worker_name}\n` +
            `Left site at ${exitTimeStr} (${dist} from "${s.job_location || 'site'}").\n` +
            `Grace: ${exitClockoutMin}min → clocked out at ${clockOutTimeStr}.\n` +
            `Hours paid: ${item.hours}h\n` +
            `View: ${settings.admin_host || 'https://admin.clockinproof.com'}/#sessions`
          ).catch(() => {})
        }

        results.push(item)
        continue
      }
    }

    // ── 4. AWAY/IDLE FLAG ────────────────────────────────────────────────────
    // Check when last ping was received — if too long ago, flag as away.
    // GRACE PERIOD: Never flag away within the first (awayWarningMin + 5) minutes
    // of clock-in. The ping interval is 5 min, so the worker needs time to send
    // the first ping before we start counting. Without this grace period, a worker
    // who clocks in and the ping hasn't fired yet gets flagged as "GPS lost" after
    // awayWarningMin minutes even though they're still at the site.
    const minssinceClockIn = (nowMs - clockInMs) / (1000 * 60)
    const awayGraceMin     = awayWarningMin + 6  // ping interval (5 min) + 1 min buffer

    const lastPing = await db.prepare(
      'SELECT timestamp FROM location_pings WHERE session_id=? ORDER BY timestamp DESC LIMIT 1'
    ).bind(s.id).first<any>()

    // If no pings yet AND still within grace window → not away
    if (!lastPing && minssinceClockIn < awayGraceMin) {
      // Still in the initial grace period — skip away check entirely
      item.hours_worked    = Math.round(hoursWorked * 10) / 10
      item.max_shift_hours = maxShiftHours
      item.away_flag       = 0
      item.drift_flag      = s.drift_flag
      item.auto_clockout   = s.auto_clockout
      if (!item.action) results.push(item)
      continue
    }

    const lastPingMs = lastPing
      ? new Date(lastPing.timestamp).getTime()
      : clockInMs   // no pings at all even after grace: use clock-in time as baseline

    const minsSincePing = (nowMs - lastPingMs) / (1000 * 60)

    if (minsSincePing >= awayWarningMin && !s.away_flag) {
      await db.prepare(
        `UPDATE sessions SET away_flag=1, away_since=? WHERE id=?`
      ).bind(new Date(lastPingMs).toISOString(), s.id).run()
      item.action = 'away_flagged'
      item.mins_away = Math.round(minsSincePing)
      results.push(item)
    } else if (minsSincePing < awayWarningMin && s.away_flag) {
      // Worker came back — clear the flag
      await db.prepare(
        `UPDATE sessions SET away_flag=0, away_since=NULL WHERE id=?`
      ).bind(s.id).run()
      item.action = 'away_cleared'
      results.push(item)
    }

    // Provide current status for the calling worker app
    item.hours_worked    = Math.round(hoursWorked * 10) / 10
    item.max_shift_hours = maxShiftHours
    item.away_flag       = s.away_flag
    item.drift_flag      = s.drift_flag
    item.auto_clockout   = s.auto_clockout
    if (!item.action) results.push(item)
  }

  return c.json({ checked: activeSessions.results.length, results })
})

// ─── FEATURE 1: SESSION TIME EDITOR ──────────────────────────────────────────

// PUT /api/sessions/:id/edit  — admin adjusts clock_in_time / clock_out_time
app.put('/api/sessions/:id/edit', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({})) as any
  const { clock_in_time, clock_out_time, reason } = body

  if (!reason || !reason.trim()) {
    return c.json({ error: 'A reason is required for session edits' }, 400)
  }

  const session = await db.prepare(
    'SELECT * FROM sessions WHERE id = ?'
  ).bind(id).first() as any
  if (!session) return c.json({ error: 'Session not found' }, 404)

  const edits: any[] = []

  if (clock_in_time && clock_in_time !== session.clock_in_time) {
    edits.push({ field: 'clock_in_time', old: session.clock_in_time, new: clock_in_time })
  }
  if (clock_out_time && clock_out_time !== session.clock_out_time) {
    edits.push({ field: 'clock_out_time', old: session.clock_out_time, new: clock_out_time })
  }
  if (edits.length === 0) return c.json({ error: 'No changes detected' }, 400)

  // Calculate new hours & earnings based on final times
  const finalIn  = new Date(clock_in_time  || session.clock_in_time)
  const finalOut = new Date(clock_out_time || session.clock_out_time)
  const newHours    = Math.round(((finalOut.getTime() - finalIn.getTime()) / 3600000) * 100) / 100
  const newEarnings = Math.round(newHours * (session.hourly_rate || 0) * 100) / 100

  await db.prepare(
    `UPDATE sessions SET
      clock_in_time  = COALESCE(?, clock_in_time),
      clock_out_time = COALESCE(?, clock_out_time),
      total_hours    = ?,
      earnings       = ?,
      edited         = 1,
      edit_reason    = ?
    WHERE id = ?`
  ).bind(
    clock_in_time  || null,
    clock_out_time || null,
    newHours,
    newEarnings,
    reason.trim(),
    id
  ).run()

  // Write audit log for each changed field
  for (const e of edits) {
    await db.prepare(
      `INSERT INTO session_edits (session_id, field, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, e.field, e.old, e.new, reason.trim()).run()
  }

  const updated = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()
  return c.json({ success: true, session: updated, new_hours: newHours, new_earnings: newEarnings })
})

// GET /api/sessions/:id/edits  — audit trail for a session
app.get('/api/sessions/:id/edits', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const edits = await db.prepare(
    'SELECT * FROM session_edits WHERE session_id = ? ORDER BY edited_at DESC'
  ).bind(id).all()
  return c.json({ edits: edits.results })
})

// ─── FEATURE 2: JOB SITES MANAGER ────────────────────────────────────────────

app.get('/api/job-sites', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const sites = await db.prepare(
    'SELECT * FROM job_sites WHERE active = 1 AND tenant_id = ? ORDER BY name ASC'
  ).bind(tenantId).all()
  return c.json({ sites: sites.results })
})

app.post('/api/job-sites', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const { name, address } = await c.req.json().catch(() => ({})) as any
  if (!name?.trim() || !address?.trim()) {
    return c.json({ error: 'Name and address are required' }, 400)
  }
  // Geocode the address to get lat/lng
  let lat: number | null = null, lng: number | null = null
  try {
    const geo = await geocodeAddress(address.trim())
    if (geo) { lat = geo.lat; lng = geo.lng }
  } catch(_) {}

  const result = await db.prepare(
    'INSERT INTO job_sites (name, address, lat, lng, tenant_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(name.trim(), address.trim(), lat, lng, tenantId).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.put('/api/job-sites/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const id = c.req.param('id')
  const { name, address, active } = await c.req.json().catch(() => ({})) as any

  let lat: number | null = null, lng: number | null = null
  if (address) {
    try {
      const geo = await geocodeAddress(address.trim())
      if (geo) { lat = geo.lat; lng = geo.lng }
    } catch(_) {}
  }

  await db.prepare(
    `UPDATE job_sites SET
      name    = COALESCE(?, name),
      address = COALESCE(?, address),
      lat     = CASE WHEN ? IS NOT NULL THEN ? ELSE lat END,
      lng     = CASE WHEN ? IS NOT NULL THEN ? ELSE lng END,
      active  = COALESCE(?, active)
    WHERE id = ? AND tenant_id = ?`
  ).bind(
    name?.trim() || null,
    address?.trim() || null,
    address ? lat : null, lat,
    address ? lng : null, lng,
    active !== undefined ? (active ? 1 : 0) : null,
    id, tenantId
  ).run()
  return c.json({ success: true })
})

app.delete('/api/job-sites/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  await db.prepare('UPDATE job_sites SET active = 0 WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), tenantId).run()
  return c.json({ success: true })
})

// ─── JOB DISPATCH API ────────────────────────────────────────────────────────

// POST /api/dispatch  — send a job to a worker via SMS
app.post('/api/dispatch', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const body = await c.req.json() as any
  const {
    job_site_id,
    encircle_claim_id,
    job_name,
    job_address,
    worker_id,
    notes
  } = body

  if (!worker_id)    return c.json({ error: 'worker_id required' }, 400)
  if (!job_address)  return c.json({ error: 'job_address required' }, 400)
  if (!job_name)     return c.json({ error: 'job_name required' }, 400)

  // Fetch worker (must belong to this tenant)
  const worker = await db.prepare('SELECT id, name, phone FROM workers WHERE id = ? AND tenant_id = ? AND active = 1').bind(worker_id, tenantId).first() as any
  if (!worker) return c.json({ error: 'Worker not found or inactive' }, 404)
  if (!worker.phone) return c.json({ error: 'Worker has no phone number on file' }, 400)

  // Build Google Maps URL using the address string
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(job_address)}`

  // Compose the SMS message
  const notesLine = notes ? `\nNote: ${notes}` : ''
  const smsText = `🏠 New Job Assignment\n${job_name}\n📍 ${job_address}\n\n👆 Tap for directions:\n${mapsUrl}${notesLine}\n\nReply "On my way" or any message when you're heading out. Clock in when you arrive.`

  // Send via Twilio
  const smsResult = await sendWorkerSms(c.env, worker.phone, smsText)

  // Record the dispatch regardless of SMS result (so admin can see it)
  const ins = await db.prepare(`
    INSERT INTO job_dispatches
      (job_site_id, encircle_claim_id, job_name, job_address, maps_url,
       worker_id, worker_name, worker_phone, status, sms_sid, notes, tenant_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    job_site_id || null,
    encircle_claim_id || null,
    job_name,
    job_address,
    mapsUrl,
    worker.id,
    worker.name,
    worker.phone,
    smsResult.sent ? 'sent' : 'failed',
    null,
    notes || null,
    tenantId
  ).run()

  if (!smsResult.sent) {
    return c.json({
      success: false,
      dispatch_id: ins.meta.last_row_id,
      error: smsResult.error || 'SMS failed to send',
      sms_sent: false
    }, 200)
  }

  return c.json({
    success: true,
    dispatch_id: ins.meta.last_row_id,
    sms_sent: true,
    worker_name: worker.name,
    worker_phone: worker.phone
  })
})

// GET /api/dispatch  — list recent dispatches
app.get('/api/dispatch', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const limit = parseInt(c.req.query('limit') || '50')
  const rows = await db.prepare(`
    SELECT d.*,
      w.name  AS worker_name_live,
      w.phone AS worker_phone_live
    FROM job_dispatches d
    LEFT JOIN workers w ON w.id = d.worker_id
    WHERE d.tenant_id = ?
    ORDER BY d.created_at DESC
    LIMIT ?
  `).bind(tenantId, limit).all()
  return c.json({ dispatches: rows.results })
})

// GET /api/dispatch/stats  — summary counts by status
app.get('/api/dispatch/stats', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='sent'      THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='replied'   THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN status='arrived'   THEN 1 ELSE 0 END) AS arrived,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status='failed'    THEN 1 ELSE 0 END) AS failed
    FROM job_dispatches
    WHERE tenant_id = ? AND created_at >= datetime('now','-7 days')
  `).bind(tenantId).first() as any
  return c.json(row || {})
})

// DELETE /api/dispatch/:id  — cancel a dispatch
app.delete('/api/dispatch/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  await db.prepare(`UPDATE job_dispatches SET status='cancelled' WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// GET /api/dispatch/pending/:worker_id  — return the most recent active dispatch for a worker
// Used by the worker app to pre-fill the job modal and show a dispatch banner
app.get('/api/dispatch/pending/:worker_id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const workerId = c.req.param('worker_id')
  // Return the most recent dispatch sent to this worker in the last 48 hours that hasn't been cancelled
  const row = await db.prepare(`
    SELECT d.*, js.id AS matched_site_id
    FROM job_dispatches d
    LEFT JOIN job_sites js ON (
      js.encircle_job_id = d.encircle_claim_id
      OR js.address = d.job_address
    )
    WHERE d.worker_id = ?
      AND d.status IN ('sent','replied','arrived','failed')
      AND d.created_at >= datetime('now','-48 hours')
    ORDER BY d.created_at DESC
    LIMIT 1
  `).bind(workerId).first() as any
  if (!row) return c.json({ dispatch: null })
  return c.json({ dispatch: row })
})

// GET /api/dispatch/worker/:worker_id — all dispatches for a worker (pending + last 30 days)
// Used by the worker app Dispatches tab
app.get('/api/dispatch/worker/:worker_id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const workerId = c.req.param('worker_id')
  const rows = await db.prepare(`
    SELECT d.*
    FROM job_dispatches d
    WHERE d.worker_id = ?
      AND d.created_at >= datetime('now','-30 days')
    ORDER BY d.created_at DESC
    LIMIT 50
  `).bind(workerId).all()
  return c.json({ dispatches: rows.results || [] })
})

// POST /api/dispatch/:id/respond — worker responds to a dispatch (accept / decline / arrived)
app.post('/api/dispatch/:id/respond', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { worker_id, response } = await c.req.json() as any  // response: 'accepted'|'declined'|'arrived'
  if (!worker_id || !response) return c.json({ error: 'worker_id and response required' }, 400)
  // Verify this dispatch belongs to this worker
  const disp = await db.prepare(`SELECT * FROM job_dispatches WHERE id = ? AND worker_id = ?`).bind(id, worker_id).first() as any
  if (!disp) return c.json({ error: 'Dispatch not found' }, 404)
  const newStatus = response === 'arrived' ? 'arrived' : response === 'accepted' ? 'replied' : 'cancelled'
  const replyText = response === 'arrived' ? 'Worker marked as arrived' : response === 'accepted' ? 'Accepted via app' : 'Declined via app'
  await db.prepare(`
    UPDATE job_dispatches SET status = ?, reply_text = ?, reply_at = datetime('now')
    ${response === 'arrived' ? ", arrived_at = datetime('now')" : ''}
    WHERE id = ?
  `).bind(newStatus, replyText, id).run()
  return c.json({ success: true, status: newStatus })
})

// POST /api/test/sms  — Super admin test endpoint to verify Twilio is working
app.post('/api/test/sms', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  const { to, message } = await c.req.json() as any
  if (!to) return c.json({ error: 'to required' }, 400)
  const result = await sendWorkerSms(env, to, message || '✅ ClockInProof SMS test — platform messaging is working!')
  return c.json(result.sent ? { success: true } : { success: false, error: result.error })
})

// POST /api/test/email  — Super admin test endpoint to verify Resend is working
app.post('/api/test/email', async (c) => {
  const env = c.env as any
  const { to } = await c.req.json() as any
  if (!to) return c.json({ error: 'to required' }, 400)
  const resendKey  = (env.RESEND_API_KEY || '').trim()
  const resendFrom = (env.RESEND_FROM    || 'ClockInProof <alerts@clockinproof.com>').trim()
  if (!resendKey) return c.json({ success: false, error: 'RESEND_API_KEY not configured' })
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: resendFrom,
        to: [to],
        subject: '✅ ClockInProof — Platform Email Test',
        html: '<p style="font-family:sans-serif;padding:24px"><strong>✅ ClockInProof platform email is working!</strong><br><br>This is a test from the Super Admin platform settings.</p>'
      })
    })
    if (res.ok) return c.json({ success: true })
    const err = await res.json() as any
    return c.json({ success: false, error: err?.message || `Resend error ${res.status}` })
  } catch(e: any) {
    return c.json({ success: false, error: e.message })
  }
})

// ─── STRIPE CHECKOUT + BILLING ────────────────────────────────────────────────

// POST /api/stripe/checkout — create a Stripe Checkout Session and return the URL
app.post('/api/stripe/checkout', async (c) => {
  const db  = c.env.DB
  const env = c.env
  const stripeKey = env.STRIPE_SECRET_KEY || ''
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 500)

  const body = await c.req.json() as any
  const { tenant_id, price_id, email, company_name, slug, plan, success_url, cancel_url } = body
  if (!price_id || !email || !success_url) return c.json({ error: 'Missing required fields' }, 400)

  try {
    const params = new URLSearchParams({
      'mode': 'subscription',
      'payment_method_types[0]': 'card',
      'line_items[0][price]': price_id,
      'line_items[0][quantity]': '1',
      'customer_email': email,
      'subscription_data[trial_period_days]': '14',
      'subscription_data[metadata][tenant_id]': String(tenant_id || ''),
      'subscription_data[metadata][slug]': slug || '',
      'subscription_data[metadata][plan]': plan || '',
      'metadata[tenant_id]': String(tenant_id || ''),
      'metadata[slug]': slug || '',
      'metadata[plan]': plan || '',
      'success_url': success_url + '&session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': cancel_url || 'https://clockinproof.com/pricing',
    })

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    })
    const session = await res.json() as any
    if (!res.ok) return c.json({ error: session.error?.message || 'Stripe error' }, 500)
    return c.json({ url: session.url, session_id: session.id })
  } catch (e: any) {
    return c.json({ error: e.message || 'Checkout failed' }, 500)
  }
})

// ── Stripe webhook signature verification (Web Crypto — no npm needed) ────────
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  try {
    const parts: Record<string, string> = {}
    for (const part of sigHeader.split(',')) {
      const [k, v] = part.split('=')
      parts[k] = v
    }
    const timestamp = parts['t']
    const sig       = parts['v1']
    if (!timestamp || !sig) return false

    // Reject if older than 5 minutes
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parseInt(timestamp)) > 300) return false

    const signedPayload = `${timestamp}.${payload}`
    const enc     = new TextEncoder()
    const key     = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sigBuf  = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload))
    const computed = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2,'0')).join('')
    return computed === sig
  } catch {
    return false
  }
}

// POST /api/stripe/webhook — Stripe sends events here on subscription changes
// Configure in Stripe Dashboard: Developers → Webhooks → Add endpoint
// URL: https://admin.clockinproof.com/api/stripe/webhook
// Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
app.post('/api/stripe/webhook', async (c) => {
  const db  = c.env.DB
  const env = c.env
  const stripeKey    = env.STRIPE_SECRET_KEY || ''
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET || ''
  if (!stripeKey) return c.text('Not configured', 500)

  const body      = await c.req.text()
  const sigHeader = c.req.header('stripe-signature') || ''

  // Verify signature if secret is configured (reject unsigned events in production)
  if (webhookSecret) {
    const valid = await verifyStripeSignature(body, sigHeader, webhookSecret)
    if (!valid) return c.text('Invalid signature', 400)
  }

  let event: any
  try {
    event = JSON.parse(body)
  } catch {
    return c.text('Invalid payload', 400)
  }

  const type = event.type
  const obj  = event.data?.object

  if (type === 'checkout.session.completed') {
    const meta      = obj.metadata || {}
    const tenantId  = meta.tenant_id
    const slug      = meta.slug
    const plan      = meta.plan || 'starter'
    const custId    = obj.customer
    const subId     = obj.subscription
    const planLimits: Record<string, number> = { starter: 10, growth: 25, pro: 999 }
    const maxWorkers = planLimits[plan] || 10

    // Resolve the actual slug used
    let resolvedSlug = slug
    if (tenantId) {
      await db.prepare(`
        UPDATE tenants SET status='active', stripe_customer_id=?, stripe_subscription_id=?,
        plan=?, max_workers=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(custId, subId, plan, maxWorkers, parseInt(tenantId)).run()
      const t = await db.prepare(`SELECT slug FROM tenants WHERE id=?`).bind(parseInt(tenantId)).first() as any
      resolvedSlug = t?.slug || slug
    } else if (slug) {
      await db.prepare(`
        UPDATE tenants SET status='active', stripe_customer_id=?, stripe_subscription_id=?,
        plan=?, max_workers=?, updated_at=CURRENT_TIMESTAMP WHERE slug=?
      `).bind(custId, subId, plan, maxWorkers, slug).run()
    }

    // Auto-provision the tenant subdomain on Cloudflare Pages
    if (resolvedSlug && env.CLOUDFLARE_API_TOKEN && env.CF_ACCOUNT_ID) {
      const subdomain = `${resolvedSlug}.clockinproof.com`
      try {
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/clockinproof/domains`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: subdomain })
          }
        )
      } catch { /* non-fatal — subdomain can be added manually */ }
    }
  }

  if (type === 'customer.subscription.updated') {
    const custId = obj.customer
    const status = obj.status // active, past_due, canceled, trialing
    const tenantStatus = (status === 'active' || status === 'trialing') ? 'active' : 'suspended'
    await db.prepare(`UPDATE tenants SET status=?, updated_at=CURRENT_TIMESTAMP WHERE stripe_customer_id=?`)
      .bind(tenantStatus, custId).run()
  }

  if (type === 'customer.subscription.deleted') {
    const custId = obj.customer
    await db.prepare(`UPDATE tenants SET status='suspended', updated_at=CURRENT_TIMESTAMP WHERE stripe_customer_id=?`)
      .bind(custId).run()
  }

  return c.text('ok', 200)
})

// GET /api/stripe/portal — create a billing portal session for tenant self-service
app.get('/api/stripe/portal', async (c) => {
  const db  = c.env.DB
  const env = c.env
  const stripeKey = env.STRIPE_SECRET_KEY || ''
  if (!stripeKey) return c.json({ error: 'Stripe not configured' }, 500)

  const tenant = await db.prepare(`SELECT stripe_customer_id FROM tenants WHERE id=1`).first() as any
  if (!tenant?.stripe_customer_id) return c.json({ error: 'No billing account found' }, 404)

  const params = new URLSearchParams({
    customer: tenant.stripe_customer_id,
    return_url: 'https://admin.clockinproof.com/#settings'
  })
  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  const session = await res.json() as any
  if (!res.ok) return c.json({ error: session.error?.message || 'Portal error' }, 500)
  return c.json({ url: session.url })
})

// POST /api/twilio/webhook  — inbound SMS from workers (Twilio calls this URL)
// Configure in Twilio Console: Messaging → Phone Number → Incoming messages webhook
// URL: https://admin.clockinproof.com/api/twilio/webhook  Method: POST
app.post('/api/twilio/webhook', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)

  // Twilio sends form-encoded body
  const text = await c.req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(text)) params[k] = v

  const fromRaw = (params['From'] || '').replace(/\D/g,'').replace(/^1/, '')
  const body    = (params['Body'] || '').trim()
  const smsSid  = params['SmsSid'] || params['MessageSid'] || ''

  if (!fromRaw || !body) {
    return new Response('<?xml version="1.0"?><Response></Response>', {
      headers: { 'Content-Type': 'text/xml' }
    })
  }

  // Find the most recent non-arrived dispatch for this worker phone number
  const dispatch = await db.prepare(`
    SELECT d.* FROM job_dispatches d
    INNER JOIN workers w ON w.id = d.worker_id
    WHERE (w.phone LIKE ? OR w.phone LIKE ?)
      AND d.status IN ('sent','replied')
    ORDER BY d.created_at DESC LIMIT 1
  `).bind(`%${fromRaw}`, `%1${fromRaw}`).first() as any

  if (dispatch) {
    await db.prepare(`
      UPDATE job_dispatches
      SET status='replied', reply_text=?, reply_at=datetime('now')
      WHERE id=?
    `).bind(body, dispatch.id).run()
  }

  // Always return empty TwiML so Twilio doesn't auto-reply
  return new Response('<?xml version="1.0"?><Response></Response>', {
    headers: { 'Content-Type': 'text/xml' }
  })
})

// ─── ENCIRCLE INTEGRATION API ────────────────────────────────────────────────

// Helper: run full Encircle sync (used by manual trigger and cron)
async function runEncircleSync(db: D1Database): Promise<{
  jobs_added: number; jobs_updated: number; jobs_closed: number; jobs_skipped?: number;
  status: string; error_message?: string
}> {
  const settings = await db.prepare('SELECT * FROM encircle_settings WHERE id = 1').first() as any
  if (!settings?.bearer_token) {
    return { jobs_added: 0, jobs_updated: 0, jobs_closed: 0, status: 'error', error_message: 'No bearer token configured' }
  }
  try {
    const resp = await fetch('https://api.encircleapp.com/v1/property_claims', {
      headers: {
        'Authorization': `Bearer ${settings.bearer_token}`,
        'Content-Type': 'application/json'
      }
    })
    if (!resp.ok) {
      const errText = await resp.text()
      const msg = resp.status === 401
        ? 'Encircle connection lost – please reconnect in Settings.'
        : `Encircle API error ${resp.status}: ${errText}`
      await db.prepare(`INSERT INTO encircle_sync_log (jobs_added,jobs_updated,jobs_closed,status,error_message) VALUES (0,0,0,'error',?)`).bind(msg).run()
      return { jobs_added: 0, jobs_updated: 0, jobs_closed: 0, status: 'error', error_message: msg }
    }
    const data = await resp.json() as any
    const allClaims = data.list || []

    // ── Filter out closed/archived/leave jobs — only import truly active claims ──
    const CLOSED_STATUSES = [
      'closed', 'archived', 'cancelled', 'canceled',
      'complete', 'completed', 'done', 'finished',
      'leave_job', 'leave job', 'leaving', 'left',
      'inactive', 'void', 'voided', 'deleted'
    ]
    const claims = allClaims.filter((c: any) => {
      // Check every possible status field Encircle might use
      const statusFields = [
        c.status, c.claim_status, c.project_status,
        c.job_status, c.state, c.stage, c.phase
      ]
      return !statusFields.some((s: any) =>
        s && CLOSED_STATUSES.includes(String(s).toLowerCase().trim())
      )
    })
    const skippedClosed = allClaims.length - claims.length

    // ── Immediately deactivate any jobs that came back as closed/leave_job ──
    const closedClaims = allClaims.filter((c: any) => {
      const statusFields = [c.status, c.claim_status, c.project_status, c.job_status, c.state, c.stage, c.phase]
      return statusFields.some((s: any) => s && CLOSED_STATUSES.includes(String(s).toLowerCase().trim()))
    })
    for (const cc of closedClaims) {
      const ccId = String(cc.id)
      await db.prepare(`UPDATE job_sites SET active=0, encircle_status='Closed' WHERE encircle_job_id=?`).bind(ccId).run()
      await db.prepare(`UPDATE encircle_jobs SET status='closed' WHERE encircle_claim_id=?`).bind(ccId).run()
    }

    let added = 0, updated = 0, closed = 0
    const encircleIds: string[] = []

    for (const claim of claims) {
      const encId = String(claim.id)
      encircleIds.push(encId)

      // ── Derive display name: prefer policyholder name, fall back to insurer ref ──
      const policyholderName = claim.policyholder_name || ''
      const displayName = `[Encircle] ${policyholderName || claim.insurer_identifier || encId}`
      const address = claim.full_address || ''

      // ── Format type of loss for display ──────────────────────────────────────
      const rawType = claim.type_of_loss || ''
      const typeDisplay = rawType.replace('type_of_loss_', '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

      // ── Geocode address via Nominatim if no lat/lng from API ──────────────────
      let lat: number | null = null
      let lng: number | null = null
      try {
        const geo = await geocodeAddress(address)
        if (geo) { lat = geo.lat; lng = geo.lng }
      } catch (_) {}

      // ── 1. Upsert into encircle_jobs ─────────────────────────────────────────
      // CIP IS THE SOURCE OF TRUTH — never overwrite manually_closed or status
      // if the admin has explicitly closed this job in CIP
      const existingJob = await db.prepare(
        `SELECT manually_closed, status FROM encircle_jobs WHERE encircle_claim_id=?`
      ).bind(encId).first() as any

      // GUARDRAIL: skip this job entirely if manually closed in CIP
      // Even if Encircle keeps sending it — CIP decision wins
      if (existingJob?.manually_closed) {
        encircleIds.push(encId) // still track ID so deactivation doesn't flip it
        continue
      }

      await db.prepare(`
        INSERT INTO encircle_jobs (
          encircle_claim_id, policyholder_name, policyholder_phone, policyholder_email,
          full_address, type_of_loss, date_of_loss, date_claim_created,
          loss_details, project_manager_name, insurer_identifier, insurance_company_name,
          policy_number, adjuster_name, contractor_identifier, assignment_identifier,
          emergency_estimate, repair_estimate, permalink_url, status, synced_at, tenant_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',CURRENT_TIMESTAMP,1)
        ON CONFLICT(encircle_claim_id) DO UPDATE SET
          policyholder_name=excluded.policyholder_name,
          policyholder_phone=excluded.policyholder_phone,
          policyholder_email=excluded.policyholder_email,
          full_address=excluded.full_address,
          type_of_loss=excluded.type_of_loss,
          date_of_loss=excluded.date_of_loss,
          date_claim_created=excluded.date_claim_created,
          loss_details=excluded.loss_details,
          project_manager_name=excluded.project_manager_name,
          insurer_identifier=excluded.insurer_identifier,
          insurance_company_name=excluded.insurance_company_name,
          policy_number=excluded.policy_number,
          adjuster_name=excluded.adjuster_name,
          contractor_identifier=excluded.contractor_identifier,
          assignment_identifier=excluded.assignment_identifier,
          emergency_estimate=excluded.emergency_estimate,
          repair_estimate=excluded.repair_estimate,
          permalink_url=excluded.permalink_url,
          -- GUARDRAIL: only update status to 'active' if NOT manually closed
          status = CASE WHEN manually_closed = 1 THEN status ELSE 'active' END,
          synced_at=CURRENT_TIMESTAMP
      `).bind(
        encId,
        policyholderName,
        claim.policyholder_phone_number || null,
        claim.policyholder_email_address || null,
        address,
        typeDisplay || null,
        claim.date_of_loss || null,
        claim.date_claim_created || null,
        claim.loss_details || null,
        claim.project_manager_name || null,
        claim.insurer_identifier || null,
        claim.insurance_company_name || null,
        claim.policy_number || null,
        claim.adjuster_name || null,
        claim.contractor_identifier || null,
        claim.assignment_identifier || null,
        claim.emergency_estimate || null,
        claim.repair_estimate || null,
        claim.permalink_url || null
      ).run()

      // ── 2. Upsert into job_sites (for GPS geofencing) ─────────────────────────
      const existing = await db.prepare(
        `SELECT id, name, lat, lng, manually_closed FROM job_sites WHERE encircle_job_id = ?`
      ).bind(encId).first() as any

      // GUARDRAIL: CIP decision wins — never re-activate a manually closed job site
      if (existing?.manually_closed) continue

      if (!existing) {
        await db.prepare(
          `INSERT INTO job_sites (name, address, lat, lng, active, encircle_job_id, encircle_synced_at, encircle_status, tenant_id)
           VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, ?, 1)`
        ).bind(displayName, address, lat, lng, encId, typeDisplay || 'active').run()
        added++
      } else {
        const keepName = existing.name.startsWith('[Encircle]') ? displayName : existing.name
        const keepLat = (existing.lat != null) ? existing.lat : lat
        const keepLng = (existing.lng != null) ? existing.lng : lng
        await db.prepare(
          `UPDATE job_sites SET name=?, address=?, lat=?, lng=?, active=1, encircle_status=?, encircle_synced_at=CURRENT_TIMESTAMP WHERE encircle_job_id=?`
        ).bind(keepName, address, keepLat, keepLng, typeDisplay || 'active', encId).run()
        updated++
      }
    }

    // ── Deactivate jobs no longer returned by Encircle at all ─────────────────
    // GUARDRAIL: never touch manually_closed jobs — CIP owns their state
    if (encircleIds.length > 0) {
      const ph = encircleIds.map(() => '?').join(',')
      const deactivateResult = await db.prepare(
        `UPDATE job_sites SET active=0, encircle_status='Closed'
         WHERE encircle_job_id IS NOT NULL
         AND manually_closed = 0
         AND encircle_job_id NOT IN (${ph})`
      ).bind(...encircleIds).run()
      await db.prepare(
        `UPDATE encircle_jobs SET status='closed'
         WHERE manually_closed = 0
         AND encircle_claim_id NOT IN (${ph})`
      ).bind(...encircleIds).run()
      closed = (deactivateResult.meta?.changes || 0) + skippedClosed
    } else {
      closed = skippedClosed
    }

    await db.prepare(`UPDATE encircle_settings SET last_sync_at=CURRENT_TIMESTAMP WHERE id=1`).run()
    await db.prepare(`INSERT INTO encircle_sync_log (jobs_added,jobs_updated,jobs_closed,status) VALUES (?,?,?,'success')`).bind(added, updated, closed).run()
    return { jobs_added: added, jobs_updated: updated, jobs_closed: closed, jobs_skipped: skippedClosed, status: 'success' }
  } catch (e: any) {
    const msg = e?.message || 'Unknown error during sync'
    await db.prepare(`INSERT INTO encircle_sync_log (jobs_added,jobs_updated,jobs_closed,status,error_message) VALUES (0,0,0,'error',?)`).bind(msg).run()
    return { jobs_added: 0, jobs_updated: 0, jobs_closed: 0, status: 'error', error_message: msg }
  }
}

// POST /api/encircle/settings — save bearer token
app.post('/api/encircle/settings', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { bearer_token, sync_enabled } = await c.req.json().catch(() => ({})) as any
  if (!bearer_token?.trim()) return c.json({ error: 'bearer_token is required' }, 400)
  // Test token before saving
  const testResp = await fetch('https://api.encircleapp.com/v1/organizations', {
    headers: { 'Authorization': `Bearer ${bearer_token.trim()}`, 'Content-Type': 'application/json' }
  })
  if (!testResp.ok) return c.json({ error: 'Invalid token — Encircle returned ' + testResp.status }, 400)
  await db.prepare(
    `INSERT INTO encircle_settings (id, bearer_token, sync_enabled) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET bearer_token=excluded.bearer_token, sync_enabled=excluded.sync_enabled`
  ).bind(bearer_token.trim(), sync_enabled !== false ? 1 : 0).run()
  return c.json({ success: true, message: 'Encircle connected successfully' })
})

// GET /api/encircle/test — ping Encircle, return connection status
app.get('/api/encircle/test', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const settings = await db.prepare('SELECT bearer_token FROM encircle_settings WHERE id = 1').first() as any
  if (!settings?.bearer_token) return c.json({ connected: false, error: 'No token configured' })
  try {
    const resp = await fetch('https://api.encircleapp.com/v1/property_claims', {
      headers: { 'Authorization': `Bearer ${settings.bearer_token}`, 'Content-Type': 'application/json' }
    })
    if (!resp.ok) return c.json({ connected: false, error: `API returned ${resp.status}` })
    const data = await resp.json() as any
    const jobs = data.list || []
    return c.json({ connected: true, job_count: jobs.length })
  } catch (e: any) {
    return c.json({ connected: false, error: e?.message || 'Connection failed' })
  }
})

// POST /api/encircle/sync — manual sync trigger
app.post('/api/encircle/sync', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const result = await runEncircleSync(db)
  return c.json(result, result.status === 'error' ? 500 : 200)
})

// GET /api/encircle/status — latest sync info + full job contact data
app.get('/api/encircle/status', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const settings = await db.prepare(
    `SELECT id, sync_enabled, last_sync_at, created_at,
     (bearer_token IS NOT NULL AND bearer_token != '') AS has_token
     FROM encircle_settings WHERE id = 1`
  ).first() as any
  const lastLog = await db.prepare('SELECT * FROM encircle_sync_log ORDER BY synced_at DESC LIMIT 1').first() as any
  const syncLogs = await db.prepare('SELECT * FROM encircle_sync_log ORDER BY synced_at DESC LIMIT 20').all()

  // Rich job data — join encircle_jobs with job_sites for GPS status
  const syncedJobs = await db.prepare(`
    SELECT
      ej.*,
      js.lat, js.lng, js.active AS site_active,
      js.id AS job_site_id
    FROM encircle_jobs ej
    LEFT JOIN job_sites js ON js.encircle_job_id = ej.encircle_claim_id
    ORDER BY ej.date_claim_created DESC
  `).all()

  const totalCount = await db.prepare(
    `SELECT COUNT(*) as cnt FROM encircle_jobs WHERE status = 'active'`
  ).first() as any

  return c.json({
    connected: !!(settings?.has_token),
    sync_enabled: settings?.sync_enabled === 1,
    last_sync_at: settings?.last_sync_at || null,
    active_job_count: totalCount?.cnt || 0,
    last_log: lastLog || null,
    sync_logs: syncLogs.results,
    synced_jobs: syncedJobs.results
  })
})

// DELETE /api/encircle/settings — disconnect
app.delete('/api/encircle/settings', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  await db.prepare('DELETE FROM encircle_settings WHERE id = 1').run()
  // Deactivate all Encircle-synced job sites
  await db.prepare(`UPDATE job_sites SET active = 0 WHERE encircle_job_id IS NOT NULL`).run()
  return c.json({ success: true, message: 'Encircle disconnected. Synced job sites have been deactivated.' })
})

// POST /api/encircle/jobs/:claimId/close — CIP manually closes job (survives all future syncs)
app.post('/api/encircle/jobs/:claimId/close', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const claimId = c.req.param('claimId')
  let note: string | null = null
  try { const body = await c.req.json(); note = body?.note || null } catch { /* no body is fine */ }
  // Set manually_closed=1 + record who closed it and when (full audit trail)
  await db.prepare(`
    UPDATE encircle_jobs
    SET status='closed', manually_closed=1, cip_closed_at=CURRENT_TIMESTAMP, cip_closed_note=?
    WHERE encircle_claim_id=?
  `).bind(note, claimId).run()
  await db.prepare(`
    UPDATE job_sites SET active=0, manually_closed=1, encircle_status='CIP-Closed'
    WHERE encircle_job_id=?
  `).bind(claimId).run()
  return c.json({ success: true })
})

// POST /api/encircle/jobs/:claimId/reopen — CIP admin reopens a manually closed job
// This is the intentional override \u2014 admin explicitly re-activates
app.post('/api/encircle/jobs/:claimId/reopen', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const claimId = c.req.param('claimId')
  // Clear manually_closed so next sync can manage it normally again
  await db.prepare(`
    UPDATE encircle_jobs
    SET status='active', manually_closed=0, cip_closed_at=NULL, cip_closed_note=NULL
    WHERE encircle_claim_id=?
  `).bind(claimId).run()
  await db.prepare(`
    UPDATE job_sites SET active=1, manually_closed=0, encircle_status='active'
    WHERE encircle_job_id=?
  `).bind(claimId).run()
  return c.json({ success: true })
})

// ─── FEATURE 3: WORKER DISPUTE / ISSUE REPORTS ───────────────────────────────

app.post('/api/disputes', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { session_id, message } = await c.req.json().catch(() => ({})) as any
  if (!session_id || !message?.trim()) {
    return c.json({ error: 'session_id and message are required' }, 400)
  }
  // Always derive worker identity from the session — never trust client-sent worker_id
  const session = await db.prepare(
    `SELECT s.worker_id, w.name AS worker_name
     FROM sessions s
     LEFT JOIN workers w ON w.id = s.worker_id
     WHERE s.id = ?`
  ).bind(session_id).first() as any
  if (!session) return c.json({ error: 'Session not found' }, 404)

  await db.prepare(
    `INSERT INTO session_disputes (session_id, worker_id, worker_name, message) VALUES (?, ?, ?, ?)`
  ).bind(session_id, session.worker_id, session.worker_name || 'Worker', message.trim()).run()
  return c.json({ success: true, message: 'Your report has been sent to admin.' })
})

app.get('/api/disputes', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const status = c.req.query('status') || 'pending'
  const disputes = await db.prepare(
    `SELECT d.*, s.clock_in_time, s.clock_out_time, s.total_hours, s.earnings, s.job_location
     FROM session_disputes d
     LEFT JOIN sessions s ON s.id = d.session_id
     WHERE d.status = ? AND s.tenant_id = ?
     ORDER BY d.created_at DESC`
  ).bind(status, tenantId).all()
  return c.json({ disputes: disputes.results })
})

app.put('/api/disputes/:id/resolve', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { admin_response, status } = await c.req.json().catch(() => ({})) as any
  await db.prepare(
    `UPDATE session_disputes SET status = ?, admin_response = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status || 'resolved', admin_response || '', c.req.param('id')).run()
  return c.json({ success: true })
})

app.get('/api/location/session/:session_id', async (c) => {
  const db = c.env.DB
  const session_id = c.req.param('session_id')

  const pings = await db.prepare(
    'SELECT * FROM location_pings WHERE session_id = ? ORDER BY timestamp ASC'
  ).bind(session_id).all()

  return c.json({ pings: pings.results })
})

// ─── STATS API ────────────────────────────────────────────────────────────────

app.get('/api/stats/summary', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const period = c.req.query('period') || 'today' // today, week, month, all

  let dateFilter = ''
  const now = new Date()

  if (period === 'today') {
    const today = now.toISOString().split('T')[0]
    dateFilter = `AND DATE(s.clock_in_time) = '${today}'`
  } else if (period === 'week') {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    dateFilter = `AND s.clock_in_time >= '${weekAgo}'`
  } else if (period === 'month') {
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    dateFilter = `AND s.clock_in_time >= '${monthAgo}'`
  }

  const stats = await db.prepare(`
    SELECT
      COUNT(DISTINCT s.worker_id) as active_workers,
      COUNT(s.id) as total_sessions,
      SUM(CASE WHEN s.status = 'completed' THEN s.total_hours ELSE 0 END) as total_hours,
      SUM(CASE WHEN s.status = 'completed' THEN s.earnings ELSE 0 END) as total_earnings,
      COUNT(CASE WHEN s.status = 'active' THEN 1 END) as currently_working
    FROM sessions s
    WHERE s.tenant_id = ? ${dateFilter}
  `).bind(tenantId).first()

  const workerCount = await db.prepare('SELECT COUNT(*) as count FROM workers WHERE active = 1 AND tenant_id = ?').bind(tenantId).first<{count: number}>()

  return c.json({ stats: { ...stats, total_workers: workerCount?.count || 0 }, period })
})

app.get('/api/stats/worker/:worker_id', async (c) => {
  const db = c.env.DB
  const worker_id = c.req.param('worker_id')

  // Load pay period settings
  const settingsRows = await db.prepare('SELECT key, value FROM settings WHERE key IN (\'pay_frequency\',\'pay_period_anchor\',\'show_pay_to_workers\',\'timezone\')').all()
  const cfg: Record<string,string> = {}
  settingsRows.results.forEach((r: any) => { cfg[r.key] = r.value })

  const payFreq   = cfg.pay_frequency   || 'biweekly'
  const anchor    = cfg.pay_period_anchor || '2026-03-06'  // first payday
  const showPay   = cfg.show_pay_to_workers !== '0'

  // Compute current pay period bounds
  const now = new Date()
  const anchorDate = new Date(anchor + 'T00:00:00')
  const msPerDay = 86400000
  const periodDays = payFreq === 'weekly' ? 7 : payFreq === 'monthly' ? 30 : 14

  // Find start of current pay period
  const daysSinceAnchor = Math.floor((now.getTime() - anchorDate.getTime()) / msPerDay)
  const periodsSinceAnchor = Math.floor(daysSinceAnchor / periodDays)
  const periodStart = new Date(anchorDate.getTime() + periodsSinceAnchor * periodDays * msPerDay)
  const periodEnd   = new Date(periodStart.getTime() + periodDays * msPerDay)
  // Next payday = periodEnd
  const nextPayday  = periodEnd.toISOString().split('T')[0]

  const fmtDate = (d: Date) => d.toISOString().split('T')[0]
  const periodStartStr = fmtDate(periodStart)
  const periodEndStr   = fmtDate(periodEnd)

  // Today / week / month bounds
  const todayStr = fmtDate(now)
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay())
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const weekStartStr  = fmtDate(weekStart)
  const monthStartStr = fmtDate(monthStart)

  // All-time stats
  const stats = await db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(CASE WHEN status = 'completed' THEN total_hours ELSE 0 END) as total_hours,
      SUM(CASE WHEN status = 'completed' THEN earnings ELSE 0 END) as total_earnings,
      MAX(clock_in_time) as last_clock_in
    FROM sessions WHERE worker_id = ?
  `).bind(worker_id).first()

  // Today
  const today = await db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as earnings
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) = ?
  `).bind(worker_id, todayStr).first()

  // This week
  const week = await db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as earnings
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) >= ?
  `).bind(worker_id, weekStartStr).first()

  // This month
  const month = await db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as earnings
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) >= ?
  `).bind(worker_id, monthStartStr).first()

  // Current pay period
  const period = await db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as earnings
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) >= ? AND date(clock_in_time) < ?
  `).bind(worker_id, periodStartStr, periodEndStr).first()

  // Daily breakdown for current pay period
  const daily = await db.prepare(`
    SELECT date(clock_in_time) as day,
           SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as earnings,
           COUNT(*) as sessions
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) >= ? AND date(clock_in_time) < ?
    GROUP BY day ORDER BY day DESC
  `).bind(worker_id, periodStartStr, periodEndStr).all()

  return c.json({
    stats,
    breakdown: {
      today:  { hours: (today as any)?.hours || 0,  earnings: (today as any)?.earnings || 0  },
      week:   { hours: (week as any)?.hours  || 0,  earnings: (week as any)?.earnings  || 0  },
      month:  { hours: (month as any)?.hours || 0,  earnings: (month as any)?.earnings || 0  },
      period: { hours: (period as any)?.hours || 0, earnings: (period as any)?.earnings || 0 },
    },
    pay_info: {
      show_pay: showPay,
      frequency: payFreq,
      period_start: periodStartStr,
      period_end:   periodEndStr,
      next_payday:  nextPayday,
      daily: daily.results,
    }
  })
})

// GET /api/sessions/worker/:worker_id/period — sessions in the current pay period for a worker
// Used by the worker app Pay History tab
app.get('/api/sessions/worker/:worker_id/period', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const workerId = c.req.param('worker_id')
  // Load pay period settings
  const settingsRows = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('pay_frequency','pay_period_anchor','show_pay_to_workers','timezone')`).all()
  const cfg: Record<string,string> = {}
  settingsRows.results.forEach((r: any) => { cfg[r.key] = r.value })
  const payFreq  = cfg.pay_frequency    || 'biweekly'
  const anchor   = cfg.pay_period_anchor || '2026-03-06'
  const showPay  = cfg.show_pay_to_workers !== '0'
  const periodDays = payFreq === 'weekly' ? 7 : payFreq === 'monthly' ? 30 : 14
  const now = new Date()
  const anchorDate = new Date(anchor + 'T00:00:00')
  const msPerDay = 86400000
  const daysSinceAnchor = Math.floor((now.getTime() - anchorDate.getTime()) / msPerDay)
  const periodsSinceAnchor = Math.floor(daysSinceAnchor / periodDays)
  const periodStart = new Date(anchorDate.getTime() + periodsSinceAnchor * periodDays * msPerDay)
  const periodEnd   = new Date(periodStart.getTime() + periodDays * msPerDay)
  const fmtDate = (d: Date) => d.toISOString().split('T')[0]
  const startStr = fmtDate(periodStart)
  const endStr   = fmtDate(periodEnd)
  const nextPayday = endStr
  const sessions = await db.prepare(`
    SELECT id, clock_in_time, clock_out_time, total_hours, earnings,
           job_location, job_description, status, edited, edit_reason
    FROM sessions
    WHERE worker_id = ?
      AND date(clock_in_time) >= ?
      AND date(clock_in_time) < ?
    ORDER BY clock_in_time DESC
  `).bind(workerId, startStr, endStr).all()
  const totals = await db.prepare(`
    SELECT SUM(CASE WHEN status='completed' THEN total_hours ELSE 0 END) as total_hours,
           SUM(CASE WHEN status='completed' THEN earnings ELSE 0 END) as total_earnings,
           COUNT(*) as session_count
    FROM sessions WHERE worker_id = ? AND date(clock_in_time) >= ? AND date(clock_in_time) < ?
  `).bind(workerId, startStr, endStr).first() as any
  const worker = await db.prepare(`SELECT name, hourly_rate, pay_type FROM workers WHERE id = ?`).bind(workerId).first() as any
  return c.json({
    period: { start: startStr, end: endStr, next_payday: nextPayday, frequency: payFreq },
    show_pay: showPay,
    worker: { name: worker?.name, hourly_rate: worker?.hourly_rate, pay_type: worker?.pay_type },
    sessions: sessions.results || [],
    totals: { total_hours: totals?.total_hours || 0, total_earnings: totals?.total_earnings || 0, session_count: totals?.session_count || 0 }
  })
})

// ─── SETTINGS API ─────────────────────────────────────────────────────────────

app.get('/api/settings', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  // Use tenant_settings for per-tenant config
  const settings = await db.prepare('SELECT key, value FROM tenant_settings WHERE tenant_id = ?').bind(tenantId).all()
  const obj: Record<string, string> = {}
  settings.results.forEach((s: any) => { obj[s.key] = s.value })
  return c.json({ settings: obj })
})

app.put('/api/settings', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const body = await c.req.json()

  for (const [key, value] of Object.entries(body)) {
    await db.prepare(
      `INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    ).bind(tenantId, key, String(value)).run()
  }

  return c.json({ success: true })
})

// ─── ADMIN AUTH API ───────────────────────────────────────────────────────────
// POST /api/admin/login — works from any domain (admin.clockinproof.com for ALL tenants)
// Body: { email: string, pin: string }
// Returns: { success, tenant_id, slug, company_name, logo_url }
app.post('/api/admin/login', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { email, pin } = await c.req.json() as { email?: string, pin?: string }
  if (!email || !pin) return c.json({ error: 'Email and PIN required' }, 400)

  // Look up tenant by admin_email + admin_pin
  const tenant = await db.prepare(`
    SELECT id, slug, company_name, logo_url, primary_color, plan, status, trial_ends_at
    FROM tenants WHERE LOWER(admin_email) = LOWER(?) AND admin_pin = ? AND status != 'deleted'
  `).bind(email.trim(), pin.trim()).first() as any

  if (!tenant) return c.json({ error: 'Invalid email or PIN' }, 401)
  if (tenant.status === 'suspended') return c.json({ error: 'Account suspended — contact support@clockinproof.com' }, 403)

  return c.json({
    success: true,
    tenant_id: tenant.id,
    slug: tenant.slug,
    company_name: tenant.company_name,
    logo_url: tenant.logo_url || '',
    primary_color: tenant.primary_color || '#4F46E5',
    plan: tenant.plan,
    status: tenant.status,
    trial_days_left: (() => {
      if (tenant.status === "trial" && tenant.trial_ends_at) {
        const ms = new Date(tenant.trial_ends_at).getTime() - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
      } return null;
    })()
  })
})

// ─── TENANT API ───────────────────────────────────────────────────────────────
// These endpoints power the signup flow + future super admin panel

// GET /api/tenant/current — returns tenant info based on Host header
app.get('/api/tenant/current', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const slug = getTenantSlug(c.req.raw)
  if (!slug) {
    const tenant = await db.prepare(`SELECT id, slug, company_name, company_address, company_phone, company_website, logo_url, primary_color, plan, status, max_workers FROM tenants WHERE id = 1`).first()
    return c.json({ tenant, is_platform_url: true })
  }
  const tenant = await getTenantBySlug(db, slug)
  if (!tenant) return c.json({ error: 'Company not found' }, 404)
  return c.json({ tenant, is_platform_url: false })
})

// POST /api/tenant/logo — upload logo as base64 data URL, stored directly in tenants.logo_url
// Max size enforced at ~500KB (base64 ~680KB string). Supports PNG, JPG, SVG, WebP.
app.post('/api/tenant/logo', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json() as any
  const { data_url, tenant_id } = body
  if (!data_url) return c.json({ error: 'data_url required' }, 400)
  // Basic validation
  if (!data_url.startsWith('data:image/')) return c.json({ error: 'Invalid image format' }, 400)
  // Enforce ~500KB limit (base64 strings are ~1.37x raw size)
  if (data_url.length > 700000) return c.json({ error: 'Image too large — please use an image under 500KB' }, 400)
  const id = tenant_id || 1
  await db.prepare(`UPDATE tenants SET logo_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(data_url, id).run()
  return c.json({ success: true, logo_url: data_url })
})

// GET /api/plans — public pricing plans (used by landing + signup pages)
app.get('/api/plans', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const plans = await db.prepare(`SELECT * FROM stripe_plans WHERE active = 1 ORDER BY price_monthly`).all()
  return c.json({ plans: plans.results })
})

// GET /api/super/plans — all plans including inactive (super admin only)
app.get('/api/super/plans', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const plans = await db.prepare(`SELECT * FROM stripe_plans ORDER BY price_monthly`).all()
  // Count tenants per plan
  const counts = await db.prepare(
    `SELECT plan, COUNT(*) as tenant_count FROM tenants WHERE status != 'deleted' GROUP BY plan`
  ).all()
  const countMap: Record<string, number> = {}
  for (const r of counts.results as any[]) countMap[r.plan] = r.tenant_count
  const enriched = (plans.results as any[]).map(p => ({
    ...p,
    tenant_count: countMap[p.name.toLowerCase()] || 0
  }))
  return c.json({ plans: enriched })
})

// PUT /api/super/plans/:id — update a plan (name, price, features, worker limit, stripe_price_id)
app.put('/api/super/plans/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id   = c.req.param('id')
  const body = await c.req.json() as any
  const { name, stripe_price_id, price_monthly, max_workers, features, active } = body

  // Validate
  if (price_monthly !== undefined && (isNaN(price_monthly) || price_monthly < 0))
    return c.json({ error: 'Invalid price' }, 400)
  if (max_workers !== undefined && (isNaN(max_workers) || max_workers < 1))
    return c.json({ error: 'Invalid max_workers' }, 400)

  const fields: string[] = []
  const vals:   any[]    = []
  if (name            !== undefined) { fields.push('name = ?');             vals.push(name) }
  if (stripe_price_id !== undefined) { fields.push('stripe_price_id = ?');  vals.push(stripe_price_id) }
  if (price_monthly   !== undefined) { fields.push('price_monthly = ?');    vals.push(Math.round(price_monthly)) }
  if (max_workers     !== undefined) { fields.push('max_workers = ?');      vals.push(Math.round(max_workers)) }
  if (features        !== undefined) { fields.push('features = ?');         vals.push(features) }
  if (active          !== undefined) { fields.push('active = ?');           vals.push(active ? 1 : 0) }

  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  vals.push(id)

  await db.prepare(`UPDATE stripe_plans SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run()

  // If max_workers changed, also update all active tenants on this plan
  if (max_workers !== undefined && name !== undefined) {
    await db.prepare(
      `UPDATE tenants SET max_workers = ? WHERE LOWER(plan) = LOWER(?) AND status != 'deleted'`
    ).bind(Math.round(max_workers), name).run()
  }

  const updated = await db.prepare(`SELECT * FROM stripe_plans WHERE id = ?`).bind(id).first()
  return c.json({ success: true, plan: updated })
})

// GET /api/tenants — list all tenants (for future super admin)
app.get('/api/tenants/check-slug', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const slug = (c.req.query('slug') || '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!slug || slug.length < 2) return c.json({ available: false, error: 'Too short' })
  const reserved = ['admin', 'app', 'www', 'superadmin', 'api', 'mail', 'staging', 'clockinproof', 'support']
  if (reserved.includes(slug)) return c.json({ available: false, error: 'Reserved name' })
  const existing = await db.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(slug).first()
  return c.json({ available: !existing, slug })
})

app.get('/api/tenants', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenants = await db.prepare(
    `SELECT t.*, 
       (SELECT COUNT(*) FROM workers w WHERE w.tenant_id = t.id AND w.active = 1) as worker_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = t.id) as session_count
     FROM tenants t ORDER BY t.created_at DESC`
  ).all()
  return c.json({ tenants: tenants.results })
})

// POST /api/tenants — create new tenant (called by Stripe webhook or manual signup)
app.post('/api/tenants', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json()
  const { slug, company_name, company_address, admin_email, admin_pin, plan, stripe_customer_id, stripe_subscription_id } = body

  if (!slug || !company_name || !admin_email) {
    return c.json({ error: 'slug, company_name and admin_email are required' }, 400)
  }

  // Validate slug (lowercase, alphanumeric + hyphens only)
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')

  // Check uniqueness
  const existing = await db.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(cleanSlug).first()
  if (existing) return c.json({ error: `Subdomain "${cleanSlug}" is already taken` }, 409)

  const planLimits: Record<string, number> = { starter: 10, growth: 25, pro: 999 }
  const maxWorkers = planLimits[plan || 'starter'] || 10

  const result = await db.prepare(
    `INSERT INTO tenants (slug, company_name, company_address, admin_email, admin_pin, plan, status, max_workers, stripe_customer_id, stripe_subscription_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  ).bind(cleanSlug, company_name, company_address || '', admin_email, admin_pin || '1234',
    plan || 'starter', maxWorkers, stripe_customer_id || null, stripe_subscription_id || null).run()

  const tenantId = (result.meta as any).last_row_id

  // Seed default settings for new tenant
  const defaults = [
    ['app_name', company_name], ['country_code', 'CA'], ['province_code', 'ON'],
    ['timezone', 'America/Toronto'], ['work_start', '08:00'], ['work_end', '16:00'],
    ['break_morning_min', '15'], ['break_lunch_min', '30'], ['break_afternoon_min', '15'],
    ['paid_hours_per_day', '7.5'], ['work_days', '1,2,3,4,5'], ['stat_pay_multiplier', '1.5'],
    ['pay_frequency', 'biweekly'], ['pay_period_anchor', '2026-03-06'],
    ['show_pay_to_workers', '1'], ['geofence_radius_meters', '300'],
    ['gps_fraud_check', '1'], ['auto_clockout_enabled', '1'],
    ['max_shift_hours', '10'], ['away_warning_min', '30'],
    ['company_name', company_name], ['admin_email', admin_email]
  ]
  for (const [key, value] of defaults) {
    await db.prepare(
      `INSERT OR IGNORE INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)`
    ).bind(tenantId, key, value).run()
  }

  return c.json({
    success: true,
    tenant_id: tenantId,
    slug: cleanSlug,
    url: `https://${cleanSlug}.clockinproof.com`
  })
})

// PUT /api/tenants/:id — update tenant (branding, plan, status)
app.put('/api/tenants/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const body = await c.req.json()
  const allowed = ['company_name', 'company_address', 'company_phone', 'company_website',
    'admin_email', 'admin_pin', 'logo_url', 'primary_color', 'plan', 'status', 'max_workers']
  for (const key of allowed) {
    if (body[key] !== undefined) {
      await db.prepare(`UPDATE tenants SET ${key} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(body[key], id).run()
    }
  }
  return c.json({ success: true })
})

// GET /api/tenants/:id/stats — usage stats for one tenant
app.get('/api/tenants/:id/stats', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const [workers, sessions, tenant] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as count FROM workers WHERE tenant_id = ? AND active = 1`).bind(id).first(),
    db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ?`).bind(id).first(),
    db.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first()
  ])
  return c.json({ tenant, worker_count: (workers as any)?.count || 0, session_count: (sessions as any)?.count || 0 })
})

// ─── SUPER ADMIN API ROUTES ───────────────────────────────────────────────────
// POST /api/super/login — authenticate with SUPER_ADMIN_PIN
app.post('/api/super/login', async (c) => {
  const body = await c.req.json()
  const pin = (body.pin || '').toString().trim()
  const superPin = (c.env.SUPER_ADMIN_PIN || 'superadmin1965').toString().trim()
  if (pin !== superPin) {
    return c.json({ error: 'Invalid PIN' }, 401)
  }
  // Return a simple session token (PIN hash for stateless auth)
  const token = btoa(`super:${superPin}:${Date.now()}`)
  return c.json({ success: true, token })
})

// Middleware helper — verify super admin token
function verifySuperToken(c: any): boolean {
  const auth = c.req.header('X-Super-Token') || ''
  const superPin = (c.env.SUPER_ADMIN_PIN || 'superadmin1965').toString().trim()
  if (!auth) return false
  try {
    const decoded = atob(auth)
    return decoded.startsWith(`super:${superPin}:`)
  } catch { return false }
}

// GET /api/super/dashboard — overview stats
app.get('/api/super/dashboard', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  try {
    const [tenants, workers, sessions, activeSessions] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as count FROM tenants WHERE status != 'deleted'`).first(),
      db.prepare(`SELECT COUNT(*) as count FROM workers WHERE active = 1`).first(),
      db.prepare(`SELECT COUNT(*) as count FROM sessions`).first(),
      db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE clock_out_time IS NULL`).first(),
    ])
    const planBreakdown = await db.prepare(
      `SELECT plan, COUNT(*) as count FROM tenants WHERE status != 'deleted' GROUP BY plan`
    ).all()
    return c.json({
      total_tenants: (tenants as any)?.count || 0,
      total_workers: (workers as any)?.count || 0,
      total_sessions: (sessions as any)?.count || 0,
      active_sessions: (activeSessions as any)?.count || 0,
      plan_breakdown: planBreakdown.results
    })
  } catch(err: any) {
    return c.json({ error: 'Dashboard query failed', detail: err?.message || String(err) }, 500)
  }
})

// GET /api/super/tenants — full tenant list with stats
app.get('/api/super/tenants', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  try {
    const tenants = await db.prepare(`
      SELECT t.*,
        (SELECT COUNT(*) FROM workers w WHERE w.tenant_id = t.id AND w.active = 1) as worker_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = t.id) as session_count,
        (SELECT MAX(s.clock_in_time) FROM sessions s WHERE s.tenant_id = t.id) as last_active
      FROM tenants t
      WHERE t.status NOT IN ('deleted', 'archived')
      ORDER BY t.created_at DESC
    `).all()
    return c.json({ tenants: tenants.results })
  } catch(err: any) {
    return c.json({ error: 'Tenants query failed', detail: err?.message || String(err) }, 500)
  }
})

// POST /api/super/tenants — create new tenant manually
app.post('/api/super/tenants', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json()
  const { slug, company_name, company_address, admin_email, admin_pin, plan } = body
  if (!slug || !company_name) {
    return c.json({ error: 'slug and company_name are required' }, 400)
  }
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
  // Auto-generate admin email from slug if not provided: admin.{slug}@clockinproof.com
  const resolvedEmail = admin_email || ('admin.' + cleanSlug + '@clockinproof.com')
  const reserved = ['admin', 'app', 'www', 'superadmin', 'super', 'api', 'mail', 'staging', 'clockinproof', 'support']
  if (reserved.includes(cleanSlug)) return c.json({ error: 'Reserved subdomain' }, 400)
  const existing = await db.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(cleanSlug).first()
  if (existing) return c.json({ error: `Subdomain "${cleanSlug}" is already taken` }, 409)
  const planLimits: Record<string, number> = { starter: 10, growth: 25, pro: 999 }
  const maxWorkers = planLimits[plan || 'starter'] || 10
  const result = await db.prepare(
    `INSERT INTO tenants (slug, company_name, company_address, admin_email, admin_pin, plan, status, max_workers)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(cleanSlug, company_name, company_address || '', resolvedEmail, admin_pin || '1234', plan || 'starter', maxWorkers).run()
  const tenantId = (result.meta as any).last_row_id
  const defaults = [
    ['app_name', company_name], ['country_code', 'CA'], ['province_code', 'ON'],
    ['timezone', 'America/Toronto'], ['work_start', '08:00'], ['work_end', '16:00'],
    ['break_morning_min', '15'], ['break_lunch_min', '30'], ['break_afternoon_min', '15'],
    ['paid_hours_per_day', '7.5'], ['work_days', '1,2,3,4,5'], ['stat_pay_multiplier', '1.5'],
    ['pay_frequency', 'biweekly'], ['pay_period_anchor', '2026-03-06'],
    ['show_pay_to_workers', '1'], ['geofence_radius_meters', '300'],
    ['gps_fraud_check', '1'], ['auto_clockout_enabled', '1'],
    ['max_shift_hours', '10'], ['away_warning_min', '30'],
    ['company_name', company_name], ['admin_email', resolvedEmail]
  ]
  for (const [key, value] of defaults) {
    await db.prepare(`INSERT OR IGNORE INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)`)
      .bind(tenantId, key, value).run()
  }
  // Send welcome email to new tenant admin
  const resendKey = (c.env.RESEND_API_KEY || '').trim()
  if (resendKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ClockInProof <alerts@clockinproof.com>',
        to: [resolvedEmail],
        subject: `Welcome to ClockInProof — Your account is ready`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <h2 style="color:#4F46E5">Welcome to ClockInProof! 🎉</h2>
          <p>Your company <strong>${company_name}</strong> has been set up successfully.</p>
          <p><strong>Your login details:</strong></p>
          <ul>
            <li><strong>Admin email:</strong> ${resolvedEmail}</li>
            <li><strong>Admin dashboard:</strong> <a href="https://admin.clockinproof.com">admin.clockinproof.com</a></li>
            <li><strong>Worker app:</strong> <a href="https://${cleanSlug}.clockinproof.com">${cleanSlug}.clockinproof.com</a></li>
            <li><strong>Admin PIN:</strong> ${admin_pin || '1234'}</li>
            <li><strong>Plan:</strong> ${(plan || 'starter').charAt(0).toUpperCase() + (plan || 'starter').slice(1)}</li>
          </ul>
          <p>If you have any questions, reply to this email.</p>
          <p style="color:#888;font-size:12px">— ClockInProof Team</p>
        </div>`
      })
    })
  }
  return c.json({ success: true, tenant_id: tenantId, slug: cleanSlug, admin_email: resolvedEmail, url: `https://${cleanSlug}.clockinproof.com` })
})

// PUT /api/super/tenants/:id — update plan, status, limits
app.put('/api/super/tenants/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const body = await c.req.json()
  const allowed = ['company_name', 'company_address', 'admin_email', 'admin_pin', 'plan', 'status', 'max_workers', 'logo_url', 'primary_color']
  for (const key of allowed) {
    if (body[key] !== undefined) {
      await db.prepare(`UPDATE tenants SET ${key} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(body[key], id).run()
    }
  }
  // Update max_workers based on plan if plan changed
  if (body.plan) {
    const planLimits: Record<string, number> = { starter: 10, growth: 25, pro: 999 }
    const maxW = planLimits[body.plan]
    if (maxW && !body.max_workers) {
      await db.prepare(`UPDATE tenants SET max_workers = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(maxW, id).run()
    }
  }
  return c.json({ success: true })
})

// DELETE /api/super/tenants/:id — soft delete (set status = deleted)
app.delete('/api/super/tenants/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  if (id === '1') return c.json({ error: 'Cannot delete the primary tenant' }, 403)
  // Check tenant exists
  const tenant = await db.prepare(`SELECT id, company_name, status FROM tenants WHERE id = ?`).bind(id).first() as any
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (tenant.status === 'archived') return c.json({ error: 'Tenant is already archived' }, 409)
  // Soft-delete: status=archived + timestamp (purged after 90 days by super admin)
  await db.prepare(`
    UPDATE tenants
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(id).run()
  return c.json({ success: true, message: `"${tenant.company_name}" has been archived. All data preserved for 90 days.` })
})

// GET /api/super/tenants/archived — list archived tenants with days-until-purge
app.get('/api/super/tenants/archived', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const tenants = await db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM workers w WHERE w.tenant_id = t.id AND w.active = 1) as worker_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.tenant_id = t.id) as session_count,
      CAST(julianday(datetime(COALESCE(t.archived_at, t.updated_at))) + 90 - julianday('now') AS INTEGER) as days_until_purge
    FROM tenants t
    WHERE t.status IN ('archived', 'deleted')
    ORDER BY t.archived_at DESC, t.updated_at DESC
  `).all()
  return c.json({ tenants: tenants.results })
})

// POST /api/super/tenants/:id/restore — restore an archived tenant back to trial
app.post('/api/super/tenants/:id/restore', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const tenant = await db.prepare(`SELECT id, company_name, status FROM tenants WHERE id = ?`).bind(id).first() as any
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  if (!['archived', 'deleted'].includes(tenant.status)) return c.json({ error: 'Tenant is not archived' }, 409)
  await db.prepare(`
    UPDATE tenants
    SET status = 'active', archived_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(id).run()
  return c.json({ success: true, message: `"${tenant.company_name}" has been restored to active status.` })
})

// POST /api/super/tenants/:id/impersonate — get admin URL for tenant
app.get('/api/super/tenants/:id/impersonate', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first() as any
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  return c.json({
    admin_url: `https://admin.clockinproof.com/?tenant=${tenant.slug}`,
    app_url: `https://${tenant.slug}.clockinproof.com`,
    slug: tenant.slug,
    admin_pin: tenant.admin_pin
  })
})

// GET /api/super/tenants/:id/profile — full landlord view of one tenant
app.get('/api/super/tenants/:id/profile', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  try {

  const tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first() as any
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)

  // Workers breakdown
  const workers = await db.prepare(`
    SELECT id, name, phone, worker_status as status, device_id, created_at,
      (SELECT COUNT(*) FROM sessions WHERE worker_id = workers.id) as session_count,
      (SELECT MAX(clock_in_time) FROM sessions WHERE worker_id = workers.id) as last_session
    FROM workers WHERE tenant_id = ? ORDER BY name
  `).bind(id).all()

  // Recent sessions (last 10)
  const sessions = await db.prepare(`
    SELECT s.id, s.clock_in_time as clock_in, s.clock_out_time as clock_out,
           s.total_hours,
           CASE WHEN s.clock_out_time IS NULL THEN 'active' ELSE 'completed' END as status,
           w.name as worker_name, w.phone as worker_phone
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE s.tenant_id = ?
    ORDER BY s.clock_in_time DESC LIMIT 10
  `).bind(id).all()

  // Open support tickets (graceful if table missing)
  const tickets = await db.prepare(`
    SELECT id, subject, status, priority, created_at
    FROM support_tickets WHERE tenant_id = ? AND status != 'closed'
    ORDER BY created_at DESC
  `).bind(id).all().catch(() => ({ results: [] }))

  // Device reset requests pending
  const deviceResets = await db.prepare(`
    SELECT dr.id, dr.status, dr.created_at, w.name as worker_name, w.phone
    FROM device_reset_requests dr
    JOIN workers w ON dr.worker_id = w.id
    WHERE dr.tenant_id = ? AND dr.status = 'pending'
  `).bind(id).all().catch(() => ({ results: [] }))

  // Session stats — clocked in = no clock_out_time yet
  const sessionStats = await db.prepare(`
    SELECT
      COUNT(CASE WHEN clock_out_time IS NULL THEN 1 END) as currently_in,
      COUNT(*) as total_sessions,
      ROUND(SUM(total_hours),1) as total_hours
    FROM sessions WHERE tenant_id = ?
  `).bind(id).first() as any

  // Worker stats — production uses 'worker_status' column (not 'status')
  const workerStatsByStatus = await db.prepare(`
    SELECT
      COUNT(CASE WHEN worker_status='active'     THEN 1 END) as active_workers,
      COUNT(CASE WHEN worker_status='on_holiday' THEN 1 END) as on_holiday,
      COUNT(CASE WHEN worker_status='sick_leave' THEN 1 END) as sick_leave,
      COUNT(CASE WHEN worker_status='suspended'  THEN 1 END) as suspended,
      COUNT(CASE WHEN worker_status='terminated' THEN 1 END) as terminated,
      COUNT(*) as total_workers
    FROM workers WHERE tenant_id = ?
  `).bind(id).first() as any

  const createdAt  = tenant.created_at ? new Date(tenant.created_at) : null
  const daysSince  = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null

  return c.json({
    tenant: {
      ...tenant,
      days_active: daysSince,
      admin_url: `https://admin.clockinproof.com/?tenant=${tenant.slug}`,
      app_url:   `https://${tenant.slug}.clockinproof.com`
    },
    stats:                { ...workerStatsByStatus, ...sessionStats },
    workers:              workers.results,
    recent_sessions:      sessions.results,
    open_tickets:         tickets.results,
    pending_device_resets: deviceResets.results
  })
  } catch(err: any) {
    return c.json({ error: 'Profile query failed', detail: err?.message || String(err) }, 500)
  }
})

// GET /api/super/live — currently clocked-in workers across all tenants
app.get('/api/super/live', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  try {
    const rows = await db.prepare(`
      SELECT s.id as session_id, s.clock_in_time, s.clock_in_address, s.job_location,
             w.name as worker_name, w.id as worker_id,
             t.company_name, t.slug as tenant_slug, t.id as tenant_id
      FROM sessions s
      JOIN workers w ON w.id = s.worker_id
      JOIN tenants t ON t.id = s.tenant_id
      WHERE s.clock_out_time IS NULL
      ORDER BY s.clock_in_time DESC
    `).all()
    return c.json({ sessions: rows.results, count: rows.results.length })
  } catch(err: any) {
    return c.json({ error: err?.message || String(err) }, 500)
  }
})

// GET /api/super/sessions — all sessions across all tenants with pagination
app.get('/api/super/sessions', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '50')
  const tenantId = c.req.query('tenant_id')
  const offset = (page - 1) * limit
  try {
    const where = tenantId ? `WHERE s.tenant_id = ${parseInt(tenantId)}` : ''
    const rows = await db.prepare(`
      SELECT s.id, s.clock_in_time, s.clock_out_time, s.total_hours, s.earnings,
             s.clock_in_address, s.job_location, s.status,
             w.name as worker_name,
             t.company_name, t.slug as tenant_slug
      FROM sessions s
      JOIN workers w ON w.id = s.worker_id
      JOIN tenants t ON t.id = s.tenant_id
      ${where}
      ORDER BY s.clock_in_time DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all()
    const countRow = await db.prepare(`SELECT COUNT(*) as total FROM sessions s ${where}`).first() as any
    return c.json({ sessions: rows.results, total: countRow?.total || 0, page, limit })
  } catch(err: any) {
    return c.json({ error: err?.message || String(err) }, 500)
  }
})

// GET /api/super/revenue — revenue summary per tenant
app.get('/api/super/revenue', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  try {
    const rows = await db.prepare(`
      SELECT t.id, t.company_name, t.slug, t.plan, t.status,
             COUNT(DISTINCT w.id) as workers,
             COUNT(s.id) as sessions,
             ROUND(SUM(s.total_hours), 1) as total_hours,
             CASE t.plan
               WHEN 'starter' THEN 29
               WHEN 'growth'  THEN 59
               WHEN 'pro'     THEN 99
               ELSE 0
             END as mrr
      FROM tenants t
      LEFT JOIN workers w ON w.tenant_id = t.id AND w.active = 1
      LEFT JOIN sessions s ON s.tenant_id = t.id
      WHERE t.status != 'deleted'
      GROUP BY t.id
      ORDER BY mrr DESC
    `).all()
    const totalMrr = (rows.results as any[]).reduce((sum: number, r: any) => sum + (r.mrr || 0), 0)
    return c.json({ tenants: rows.results, total_mrr: totalMrr })
  } catch(err: any) {
    return c.json({ error: err?.message || String(err) }, 500)
  }
})

// POST /api/super/test-email — send a test email via Resend
app.post('/api/super/test-email', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const { to } = await c.req.json()
  if (!to) return c.json({ error: 'to is required' }, 400)
  const resendKey = (c.env.RESEND_API_KEY || '').trim()
  if (!resendKey) return c.json({ error: 'RESEND_API_KEY not configured' }, 500)
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ClockInProof <alerts@clockinproof.com>',
        to: [to],
        subject: '✅ ClockInProof — Super Admin Test Email',
        html: '<div style="font-family:sans-serif;padding:24px;max-width:480px"><h2 style="color:#4F46E5">Super Admin Test</h2><p>This test email was sent from the ClockInProof Super Admin portal.</p><p style="color:#888;font-size:12px">— ClockInProof Platform</p></div>'
      })
    })
    const d: any = await r.json()
    if (!r.ok) return c.json({ error: d?.message || 'Resend error' }, 500)
    return c.json({ success: true, id: d.id })
  } catch (err: any) {
    return c.json({ error: err?.message || 'Failed to send' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TAX COMPLIANCE MODULE (Super Admin only) ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/super/tax/summary — YTD stats + threshold alerts
app.get('/api/super/tax/summary', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const year = c.req.query('year') || new Date().getFullYear().toString()

  const [ytdRow, monthlyRows, deadlines, latestRate] = await Promise.all([
    db.prepare(`SELECT
      COUNT(*) as tx_count,
      SUM(CASE WHEN usd_amount > 0 THEN usd_amount ELSE 0 END) as gross_usd,
      SUM(CASE WHEN usd_amount > 0 THEN cad_amount ELSE 0 END) as gross_cad,
      SUM(CASE WHEN usd_amount < 0 THEN usd_amount ELSE 0 END) as refunds_usd,
      SUM(CASE WHEN category='fee' THEN ABS(usd_amount) ELSE 0 END) as fees_usd,
      COUNT(CASE WHEN status='pending' THEN 1 END) as pending_count
      FROM tax_transactions WHERE strftime('%Y', date) = ?`).bind(year).first(),
    db.prepare(`SELECT
      strftime('%Y-%m', date) as month,
      SUM(CASE WHEN usd_amount > 0 THEN usd_amount ELSE 0 END) as usd_revenue,
      SUM(CASE WHEN usd_amount > 0 THEN cad_amount ELSE 0 END) as cad_revenue,
      AVG(exchange_rate) as avg_rate,
      COUNT(*) as tx_count
      FROM tax_transactions WHERE strftime('%Y', date) = ?
      GROUP BY strftime('%Y-%m', date) ORDER BY month`).bind(year).all(),
    db.prepare(`SELECT * FROM tax_deadlines WHERE fiscal_year = ? ORDER BY due_date`).bind(parseInt(year)).all(),
    db.prepare(`SELECT usd_cad, rate_date FROM tax_exchange_rates ORDER BY rate_date DESC LIMIT 1`).first()
  ])

  const ytd = ytdRow as any
  const grossUsd = ytd?.gross_usd || 0
  const grossCad = ytd?.gross_cad || 0
  const t1135_triggered = grossCad >= 100000
  const fbar_triggered = grossUsd >= 10000

  // Seed default deadlines if none exist
  if (!(deadlines?.results?.length)) {
    const yr = parseInt(year)
    const seeds = [
      { form: 'Form 5472 + 1120', due: `${yr+1}-04-15`, ext: `${yr+1}-10-15`, yr },
      { form: 'Form 1040-NR',     due: `${yr+1}-06-15`, ext: `${yr+1}-10-15`, yr },
      { form: 'FBAR (FinCEN 114)',due: `${yr+1}-04-15`, ext: `${yr+1}-10-15`, yr },
      { form: 'T1135 (CRA)',       due: `${yr+1}-04-30`, ext: null, yr }
    ]
    for (const s of seeds) {
      await db.prepare(`INSERT OR IGNORE INTO tax_deadlines (form_type, due_date, extended_date, fiscal_year, status) VALUES (?,?,?,?,'pending')`)
        .bind(s.form, s.due, s.ext, s.yr).run()
    }
  }

  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('view_tax_summary', ?)`)
    .bind(`Year: ${year}`).run()

  return c.json({
    year,
    ytd: {
      gross_usd: grossUsd,
      gross_cad: grossCad,
      refunds_usd: ytd?.refunds_usd || 0,
      fees_usd: ytd?.fees_usd || 0,
      net_usd: (grossUsd || 0) + (ytd?.refunds_usd || 0) - (ytd?.fees_usd || 0),
      tx_count: ytd?.tx_count || 0,
      pending_count: ytd?.pending_count || 0
    },
    alerts: {
      t1135_triggered,
      t1135_threshold_cad: 100000,
      fbar_triggered,
      fbar_threshold_usd: 10000,
      t1135_pct: Math.min(100, Math.round((grossCad / 100000) * 100)),
      fbar_pct: Math.min(100, Math.round((grossUsd / 10000) * 100))
    },
    monthly: monthlyRows?.results || [],
    deadlines: deadlines?.results || [],
    latest_rate: latestRate || null
  })
})

// GET /api/super/tax/transactions — paginated ledger
app.get('/api/super/tax/transactions', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const year   = c.req.query('year') || new Date().getFullYear().toString()
  const page   = parseInt(c.req.query('page') || '1')
  const limit  = 50
  const offset = (page - 1) * limit
  const cat    = c.req.query('category') || ''
  const status = c.req.query('status') || ''

  let where = `WHERE strftime('%Y', date) = ?`
  const params: any[] = [year]
  if (cat)    { where += ` AND category = ?`; params.push(cat) }
  if (status) { where += ` AND status = ?`;   params.push(status) }

  const [rows, totalRow] = await Promise.all([
    db.prepare(`SELECT * FROM tax_transactions ${where} ORDER BY date DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) as cnt FROM tax_transactions ${where}`).bind(...params).first()
  ])

  return c.json({ transactions: rows?.results || [], total: (totalRow as any)?.cnt || 0, page, limit })
})

// POST /api/super/tax/transactions — manual entry
app.post('/api/super/tax/transactions', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json() as any
  const { date, description, usd_amount, category, notes, processor } = body

  // Look up exchange rate for that date
  const rateRow: any = await db.prepare(
    `SELECT usd_cad FROM tax_exchange_rates WHERE rate_date <= ? ORDER BY rate_date DESC LIMIT 1`
  ).bind(date).first()
  const rate = rateRow?.usd_cad || null
  const cad_amount = rate ? Math.round(usd_amount * rate * 100) / 100 : null

  const r = await db.prepare(
    `INSERT INTO tax_transactions (date, description, usd_amount, cad_amount, exchange_rate, category, processor, notes, status)
     VALUES (?,?,?,?,?,?,?,?,'reconciled')`
  ).bind(date, description, usd_amount, cad_amount, rate, category||'eci', processor||'manual', notes||null).run()

  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('add_transaction', ?)`)
    .bind(`Manual: ${description} USD ${usd_amount}`).run()

  return c.json({ success: true, id: r.meta.last_row_id, cad_amount, exchange_rate: rate })
})

// DELETE /api/super/tax/transactions/:id
app.delete('/api/super/tax/transactions/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  await db.prepare(`DELETE FROM tax_transactions WHERE id = ?`).bind(id).run()
  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('delete_transaction', ?)`)
    .bind(`ID: ${id}`).run()
  return c.json({ success: true })
})

// POST /api/super/tax/reconcile/:id — mark transaction as reconciled
app.post('/api/super/tax/reconcile/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { notes } = await c.req.json() as any
  await db.prepare(`UPDATE tax_transactions SET status='reconciled', reviewed_at=CURRENT_TIMESTAMP, reviewed_by='super-admin', notes=COALESCE(?,notes) WHERE id=?`)
    .bind(notes||null, id).run()
  return c.json({ success: true })
})

// GET /api/super/tax/rates — exchange rate history
app.get('/api/super/tax/rates', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM tax_exchange_rates ORDER BY rate_date DESC LIMIT 90`
  ).all()
  return c.json({ rates: rows?.results || [] })
})

// POST /api/super/tax/rates — manual rate entry or override
app.post('/api/super/tax/rates', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const { rate_date, usd_cad } = await c.req.json() as any
  await db.prepare(
    `INSERT INTO tax_exchange_rates (rate_date, usd_cad, source) VALUES (?,?,'manual')
     ON CONFLICT(rate_date) DO UPDATE SET usd_cad=excluded.usd_cad, source='manual-override'`
  ).bind(rate_date, usd_cad).run()
  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('set_exchange_rate', ?)`)
    .bind(`Date: ${rate_date} Rate: ${usd_cad}`).run()
  return c.json({ success: true })
})

// POST /api/super/tax/fetch-rate — pull live rate from Bank of Canada
app.post('/api/super/tax/fetch-rate', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  try {
    const today = new Date().toISOString().split('T')[0]
    const res = await fetch(`https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=${today}&end_date=${today}`)
    const data: any = await res.json()
    const obs = data?.observations?.[0]
    const rate = obs?.FXUSDCAD?.v ? parseFloat(obs.FXUSDCAD.v) : null
    if (!rate) return c.json({ error: 'Rate not available yet for today — try after 8 AM ET' }, 404)
    await db.prepare(
      `INSERT INTO tax_exchange_rates (rate_date, usd_cad, source) VALUES (?,?,'bankofcanada')
       ON CONFLICT(rate_date) DO UPDATE SET usd_cad=excluded.usd_cad, source='bankofcanada'`
    ).bind(today, rate).run()
    // Backfill CAD amounts for any transactions on this date missing cad_amount
    await db.prepare(
      `UPDATE tax_transactions SET cad_amount=ROUND(usd_amount*?,2), exchange_rate=? WHERE date=? AND cad_amount IS NULL`
    ).bind(rate, rate, today).run()
    return c.json({ success: true, date: today, rate })
  } catch (e: any) {
    return c.json({ error: e.message || 'Failed to fetch rate' }, 500)
  }
})

// POST /api/super/tax/sync-stripe — import last 90 days of Stripe charges
app.post('/api/super/tax/sync-stripe', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const stripeKey = c.env.STRIPE_SECRET_KEY
  if (!stripeKey) return c.json({ error: 'STRIPE_SECRET_KEY not configured' }, 500)

  try {
    const since = Math.floor(Date.now() / 1000) - 90 * 86400
    let added = 0, skipped = 0
    let url = `https://api.stripe.com/v1/charges?limit=100&created[gte]=${since}&expand[]=data.balance_transaction`
    let hasMore = true

    while (hasMore) {
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${stripeKey}` } })
      const data: any = await res.json()
      if (!res.ok) return c.json({ error: data.error?.message || 'Stripe error' }, 500)

      for (const ch of (data.data || [])) {
        if (ch.status !== 'succeeded') continue
        const chargeDate = new Date(ch.created * 1000).toISOString().split('T')[0]
        const usdAmt = ch.amount / 100
        const feeAmt = ch.balance_transaction?.fee ? ch.balance_transaction.fee / 100 : 0

        // Check for existing rate
        const rateRow: any = await db.prepare(
          `SELECT usd_cad FROM tax_exchange_rates WHERE rate_date <= ? ORDER BY rate_date DESC LIMIT 1`
        ).bind(chargeDate).first()
        const rate = rateRow?.usd_cad || null
        const cadAmt = rate ? Math.round(usdAmt * rate * 100) / 100 : null

        // Insert charge (skip if already exists)
        const existing: any = await db.prepare(
          `SELECT id FROM tax_transactions WHERE stripe_charge_id = ?`
        ).bind(ch.id).first()
        if (!existing) {
          await db.prepare(
            `INSERT INTO tax_transactions (stripe_charge_id, date, description, usd_amount, cad_amount, exchange_rate, category, processor, status)
             VALUES (?,?,?,?,?,?,'eci','stripe','pending')`
          ).bind(ch.id, chargeDate, ch.description || ch.billing_details?.name || 'Stripe Payment', usdAmt, cadAmt, rate).run()
          added++

          // Also record the Stripe fee as a separate line
          if (feeAmt > 0) {
            await db.prepare(
              `INSERT OR IGNORE INTO tax_transactions (stripe_charge_id, date, description, usd_amount, cad_amount, exchange_rate, category, processor, status)
               VALUES (?,?,?,?,?,?,'fee','stripe','reconciled')`
            ).bind(ch.id + '_fee', chargeDate, 'Stripe Processing Fee', -feeAmt,
              rate ? Math.round(-feeAmt * rate * 100) / 100 : null, rate).run()
          }
        } else { skipped++ }
      }

      hasMore = data.has_more
      if (hasMore && data.data?.length) {
        url = `https://api.stripe.com/v1/charges?limit=100&created[gte]=${since}&starting_after=${data.data[data.data.length-1].id}&expand[]=data.balance_transaction`
      }
    }

    await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('stripe_sync', ?)`)
      .bind(`Added: ${added}, Skipped: ${skipped}`).run()

    return c.json({ success: true, added, skipped })
  } catch (e: any) {
    return c.json({ error: e.message || 'Stripe sync failed' }, 500)
  }
})

// PUT /api/super/tax/deadlines/:id — mark filed / update status
app.put('/api/super/tax/deadlines/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { status, filed_date, filed_by, notes } = await c.req.json() as any
  await db.prepare(
    `UPDATE tax_deadlines SET status=COALESCE(?,status), filed_date=COALESCE(?,filed_date), filed_by=COALESCE(?,filed_by), notes=COALESCE(?,notes) WHERE id=?`
  ).bind(status||null, filed_date||null, filed_by||null, notes||null, id).run()
  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('update_deadline', ?)`)
    .bind(`ID: ${id} Status: ${status}`).run()
  return c.json({ success: true })
})

// GET /api/super/tax/export — CSV export
app.get('/api/super/tax/export', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const year = c.req.query('year') || new Date().getFullYear().toString()
  const rows = await db.prepare(
    `SELECT date, description, processor, category, usd_amount, exchange_rate, cad_amount, status, notes
     FROM tax_transactions WHERE strftime('%Y', date) = ? ORDER BY date`
  ).bind(year).all()

  const lines = ['Date,Description,Processor,Category,USD Amount,Exchange Rate (USD/CAD),CAD Amount,Status,Notes']
  for (const r of (rows?.results || []) as any[]) {
    lines.push([r.date, `"${(r.description||'').replace(/"/g,'""')}"`, r.processor, r.category,
      r.usd_amount, r.exchange_rate||'', r.cad_amount||'', r.status,
      `"${(r.notes||'').replace(/"/g,'""')}"`].join(','))
  }

  await db.prepare(`INSERT INTO tax_audit_log (action, details) VALUES ('export_csv', ?)`)
    .bind(`Year: ${year}`).run()

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="cip_tax_${year}.csv"`
    }
  })
})

// GET /api/super/tax/audit-log
app.get('/api/super/tax/audit-log', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const rows = await db.prepare(
    `SELECT * FROM tax_audit_log ORDER BY created_at DESC LIMIT 100`
  ).all()
  return c.json({ logs: rows?.results || [] })
})

// Helper: generate ticket number like CIP-2026-0042
async function generateTicketNumber(db: D1Database): Promise<string> {
  const year = new Date().getFullYear()
  const row: any = await db.prepare(
    `SELECT COUNT(*) as cnt FROM support_tickets WHERE ticket_number LIKE ?`
  ).bind(`CIP-${year}-%`).first()
  const seq = String((row?.cnt || 0) + 1).padStart(4, '0')
  return `CIP-${year}-${seq}`
}

// Helper: send ticket email notification
async function sendTicketEmail(env: any, opts: {
  to: string, subject: string, html: string
}) {
  const key = (env.RESEND_API_KEY || '').trim()
  if (!key || !opts.to) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ClockInProof Support <alerts@clockinproof.com>',
      reply_to: 'admin@clockinproof.com',
      to: [opts.to],
      subject: opts.subject,
      html: opts.html
    })
  }).catch(() => {})
}

// ─── DEVICE RESET REQUESTS ────────────────────────────────────────────────────
// Workers request a device reset when they get a new phone.
// Admin approves from the dashboard — new device_id is written on next login.
// Privacy: no biometric data, just a random browser token replacement.

// POST /api/device-reset-request — worker submits a new-phone request
// Accepts phone number (worker doesn't know their ID at this point)
app.post('/api/device-reset-request', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { phone, worker_id, reason } = await c.req.json()
  if (!phone && !worker_id) return c.json({ error: 'phone or worker_id required' }, 400)

  // ── Resolve tenant ────────────────────────────────────────────────────────
  // When called from a tenant subdomain, (c as any).tenant is set by middleware.
  // When called from app.clockinproof.com (reserved subdomain), tenant is null —
  // so we derive the tenant from the worker's own record in the DB.
  let tenant = (c as any).tenant as any

  // Look up worker first (no tenant filter yet) to derive tenant if needed
  const rawPhone = phone ? normalizePhone(phone) : null
  let worker: any = null

  if (rawPhone) {
    const variants = Array.from(new Set([
      rawPhone,
      rawPhone.startsWith('1') ? rawPhone.slice(1) : '1' + rawPhone,
      '+' + rawPhone,
      '+1' + (rawPhone.startsWith('1') ? rawPhone.slice(1) : rawPhone)
    ]))
    for (const v of variants) {
      worker = await db.prepare(
        `SELECT * FROM workers WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(','') = ? AND active = 1`
      ).bind(v.replace(/\D/g, '')).first<any>()
      if (worker) break
    }
  } else if (worker_id) {
    worker = await db.prepare('SELECT * FROM workers WHERE id = ? AND active = 1').bind(parseInt(worker_id)).first<any>()
  }

  if (!worker) return c.json({ error: 'Worker not found', message: 'Worker not found. Please check your phone number.' }, 404)

  // If no tenant from subdomain, look it up from the worker's tenant_id
  if (!tenant && worker.tenant_id) {
    tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ? AND status != 'deleted'`).bind(worker.tenant_id).first<any>()
  }
  if (!tenant) return c.json({ error: 'Tenant not found', message: 'Company not found. Please contact your manager.' }, 404)

  // Check no pending request already exists
  const pending = await db.prepare(
    `SELECT id FROM device_reset_requests WHERE worker_id = ? AND status = 'pending'`
  ).bind(worker.id).first()
  if (pending) return c.json({ error: 'already_pending', message: 'A reset request is already pending. Your manager will approve it shortly.' }, 409)

  await db.prepare(`
    INSERT INTO device_reset_requests (tenant_id, worker_id, worker_name, reason, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).bind(tenant.id, worker.id, worker.name, reason || 'New phone').run()

  // ── Notify admin — email + SMS ─────────────────────────────────────────────
  // Admin contact info + API keys are stored in the global `settings` table
  // (the admin saves them via the admin panel Settings screen → PUT /api/settings)
  // We also fall back to tenant.admin_email from the tenants table.
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const env = c.env as any
  const adminEmail  = (settings.admin_email  || settings.report_email  || tenant.admin_email || '').trim()
  const adminPhone  = (settings.admin_phone  || '').trim()
  const resendKey   = (env.RESEND_API_KEY    || settings.resend_api_key  || '').trim()
  const twilioSid   = (env.TWILIO_ACCOUNT_SID   || settings.twilio_account_sid   || '').trim()
  const twilioToken = (env.TWILIO_AUTH_TOKEN     || settings.twilio_auth_token    || '').trim()
  const twilioMsgSvc= (env.TWILIO_MESSAGING_SERVICE || settings.twilio_messaging_service || '').trim()
  const twilioFrom  = (env.TWILIO_FROM_NUMBER   || settings.twilio_from_number   || '').trim()
  // Strip any existing protocol from app_host/admin_host so we never double up
  const rawHost     = (settings.admin_host || settings.app_host || 'admin.clockinproof.com').trim()
  const adminDashboardUrl = rawHost.startsWith('http') ? rawHost.replace(/\/$/, '') : `https://${rawHost.replace(/\/$/, '')}`

  const notifyErrors: string[] = []

  // Email notification
  if (adminEmail && resendKey) {
    try {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'ClockInProof Alerts <alerts@clockinproof.com>',
          to: adminEmail,
          subject: `📱 Device Reset Request — ${worker.name}`,
          html: `<div style="font-family:sans-serif;max-width:480px">
            <h2 style="color:#4F46E5">📱 Device Reset Request</h2>
            <p><strong>${worker.name}</strong> (${worker.phone}) is requesting a device reset.</p>
            <p><strong>Reason:</strong> ${reason || 'New phone'}</p>
            <p>Log into your admin dashboard → Workers tab → find ${worker.name} → tap <strong>Approve Reset</strong>.</p>
            <p><a href="${adminDashboardUrl}/#workers" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:8px">Open Admin Dashboard → Workers Tab</a></p>
            <p style="color:#dc2626;font-size:12px;margin-top:16px"><strong>Security:</strong> Only approve this if you have personally confirmed the request with the worker.</p>
          </div>`
        })
      })
      if (!emailResp.ok) {
        const errText = await emailResp.text().catch(() => emailResp.status.toString())
        notifyErrors.push(`email:${errText}`)
      }
    } catch (e: any) { notifyErrors.push(`email:${e?.message}`) }
  } else {
    if (!adminEmail) notifyErrors.push('email:no_admin_email')
    if (!resendKey)  notifyErrors.push('email:no_resend_key')
  }

  // SMS notification via Twilio
  if (adminPhone && twilioSid && twilioToken && (twilioMsgSvc || twilioFrom)) {
    try {
      const toPhone = adminPhone.startsWith('+') ? adminPhone : `+1${adminPhone.replace(/\D/g,'')}`
      const smsBody = `ClockInProof: ${worker.name} is requesting a device reset (${reason || 'New phone'}). Log into your admin dashboard → Workers tab to approve.`
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`
      const twilioAuth = btoa(`${twilioSid}:${twilioToken}`)
      const params = new URLSearchParams({
        To: toPhone,
        Body: smsBody,
        ...(twilioMsgSvc ? { MessagingServiceSid: twilioMsgSvc } : { From: twilioFrom })
      })
      const smsResp = await fetch(twilioUrl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${twilioAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      })
      if (!smsResp.ok) {
        const errText = await smsResp.text().catch(() => smsResp.status.toString())
        notifyErrors.push(`sms:${errText}`)
      }
    } catch (e: any) { notifyErrors.push(`sms:${e?.message}`) }
  } else {
    if (!adminPhone)                        notifyErrors.push('sms:no_admin_phone')
    if (!twilioSid || !twilioToken)         notifyErrors.push('sms:no_twilio_creds')
    if (!(twilioMsgSvc || twilioFrom))      notifyErrors.push('sms:no_twilio_from')
  }

  // Return success (request was saved) but include notify_errors for debugging
  return c.json({
    success: true,
    message: 'Reset request submitted. Your manager has been notified and will approve it shortly.',
    ...(notifyErrors.length ? { notify_errors: notifyErrors } : {})
  })
})


// GET /api/device-reset-requests — admin views pending requests for their tenant
app.get('/api/device-reset-requests', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  let tenant = (c as any).tenant as any
  if (!tenant) {
    const tid = c.req.header('X-Tenant-ID')
    if (tid) tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ? AND status != 'deleted'`).bind(parseInt(tid)).first<any>()
  }
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const requests = await db.prepare(`
    SELECT r.*, w.phone as worker_phone
    FROM device_reset_requests r
    JOIN workers w ON w.id = r.worker_id
    WHERE r.tenant_id = ?
    ORDER BY r.requested_at DESC
    LIMIT 50
  `).bind(tenant.id).all()
  return c.json({ requests: requests.results })
})

// POST /api/device-reset-requests/:id/approve — admin approves and clears the device lock
app.post('/api/device-reset-requests/:id/approve', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  let tenant = (c as any).tenant as any
  if (!tenant) {
    const tid = c.req.header('X-Tenant-ID')
    if (tid) tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ? AND status != 'deleted'`).bind(parseInt(tid)).first<any>()
  }
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const id = parseInt(c.req.param('id'))

  const req = await db.prepare(
    `SELECT * FROM device_reset_requests WHERE id = ? AND tenant_id = ?`
  ).bind(id, tenant.id).first<any>()
  if (!req) return c.json({ error: 'Request not found' }, 404)

  // Clear the worker's locked device_id so they can register their new phone
  await db.prepare(
    `UPDATE workers SET device_id = NULL, device_consent_given = 0, device_consent_at = NULL WHERE id = ?`
  ).bind(req.worker_id).run()
  await db.prepare(
    `UPDATE device_reset_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin' WHERE id = ?`
  ).bind(id).run()

  return c.json({ success: true, message: 'Device reset approved. Worker can now register their new phone.' })
})

// POST /api/device-reset-requests/:id/deny — admin denies request
app.post('/api/device-reset-requests/:id/deny', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  let tenant = (c as any).tenant as any
  if (!tenant) {
    const tid = c.req.header('X-Tenant-ID')
    if (tid) tenant = await db.prepare(`SELECT * FROM tenants WHERE id = ? AND status != 'deleted'`).bind(parseInt(tid)).first<any>()
  }
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const id = parseInt(c.req.param('id'))
  const req = await db.prepare(
    `SELECT id FROM device_reset_requests WHERE id = ? AND tenant_id = ?`
  ).bind(id, tenant.id).first()
  if (!req) return c.json({ error: 'Request not found' }, 404)
  await db.prepare(
    `UPDATE device_reset_requests SET status = 'denied', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin' WHERE id = ?`
  ).bind(id).run()
  return c.json({ success: true })
})

// Admin: directly reset a worker's device (Workers tab — no request needed)
app.post('/api/workers/:id/reset-device', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenant = (c as any).tenant
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const id = parseInt(c.req.param('id'))
  const worker = await db.prepare(
    'SELECT id FROM workers WHERE id = ? AND tenant_id = ?'
  ).bind(id, tenant.id).first()
  if (!worker) return c.json({ error: 'Worker not found' }, 404)
  await db.prepare(
    `UPDATE workers SET device_id = NULL, device_consent_given = 0, device_consent_at = NULL WHERE id = ?`
  ).bind(id).run()
  // Close any pending reset requests for this worker
  await db.prepare(
    `UPDATE device_reset_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin-direct' WHERE worker_id = ? AND status = 'pending'`
  ).bind(id).run()
  return c.json({ success: true, message: 'Device lock cleared. Worker can register their new phone.' })
})

// ─── SUPPORT TICKETS ──────────────────────────────────────────────────────────
// POST /api/tickets — tenant submits a new support ticket
app.post('/api/tickets', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenant = (c as any).tenant
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const body = await c.req.json()
  const { subject, description, category, priority, submitter_name, submitter_email } = body
  if (!subject || !description) return c.json({ error: 'subject and description are required' }, 400)
  const ticketNumber = await generateTicketNumber(db)
  const result = await db.prepare(`
    INSERT INTO support_tickets
      (tenant_id, ticket_number, subject, description, category, priority, submitter_name, submitter_email, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')
  `).bind(
    tenant.id, ticketNumber, subject, description,
    category || 'general', priority || 'normal',
    submitter_name || tenant.company_name,
    submitter_email || tenant.admin_email
  ).run()
  const ticketId = (result.meta as any).last_row_id
  // Auto-add first message as the description
  await db.prepare(`
    INSERT INTO ticket_messages (ticket_id, sender_type, sender_name, message)
    VALUES (?, 'tenant', ?, ?)
  `).bind(ticketId, submitter_name || tenant.company_name, description).run()
  // Email confirmation to tenant
  const tenantEmail = submitter_email || tenant.admin_email
  if (tenantEmail) {
    await sendTicketEmail(c.env, {
      to: tenantEmail,
      subject: `[${ticketNumber}] Support Ticket Received — ${subject}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#4F46E5;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:18px">🎫 Support Ticket Created</h2>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:24px">
          <p style="color:#374151">Hi <strong>${submitter_name || tenant.company_name}</strong>,</p>
          <p style="color:#374151">Your support ticket has been received and our team is on it.</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0 0 8px 0"><strong style="color:#6366f1">Ticket #:</strong> <span style="font-family:monospace;background:#f1f5f9;padding:2px 8px;border-radius:4px">${ticketNumber}</span></p>
            <p style="margin:0 0 8px 0"><strong style="color:#6366f1">Subject:</strong> ${subject}</p>
            <p style="margin:0 0 8px 0"><strong style="color:#6366f1">Priority:</strong> ${(priority || 'normal').toUpperCase()}</p>
            <p style="margin:0"><strong style="color:#6366f1">Status:</strong> <span style="color:#059669;font-weight:700">OPEN</span></p>
          </div>
          <p style="color:#374151">We typically respond within <strong>24 hours</strong>. You will receive email updates as we work on your ticket.</p>
          <p style="color:#6b7280;font-size:12px;margin-top:24px">— ClockInProof Support Team<br>Reply to this email if you have additional information.</p>
        </div>
      </div>`
    })
  }
  // Alert super admin
  await sendTicketEmail(c.env, {
    to: 'admin@clockinproof.com',
    subject: `🎫 New Support Ticket [${ticketNumber}] from ${tenant.company_name}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#4F46E5">New Support Ticket</h2>
      <p><strong>Tenant:</strong> ${tenant.company_name} (${tenant.slug})</p>
      <p><strong>Ticket #:</strong> ${ticketNumber}</p>
      <p><strong>Subject:</strong> ${subject}</p>
      <p><strong>Priority:</strong> ${(priority || 'normal').toUpperCase()}</p>
      <p><strong>Category:</strong> ${category || 'general'}</p>
      <p><strong>From:</strong> ${submitter_name || ''} &lt;${tenantEmail}&gt;</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
      <p><strong>Description:</strong></p>
      <p style="background:#f8fafc;padding:12px;border-radius:8px;border-left:4px solid #4F46E5">${description}</p>
      <p><a href="https://app.clockinproof.com/super" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Open Super Admin</a></p>
    </div>`
  })
  return c.json({ success: true, ticket_id: ticketId, ticket_number: ticketNumber })
})

// GET /api/tickets — tenant views their own tickets
app.get('/api/tickets', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenant = (c as any).tenant
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const tickets = await db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.is_internal = 0) as message_count,
      (SELECT m.created_at FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) as last_reply_at
    FROM support_tickets t
    WHERE t.tenant_id = ?
    ORDER BY t.updated_at DESC
  `).bind(tenant.id).all()
  return c.json({ tickets: tickets.results })
})

// GET /api/tickets/:id — tenant views a specific ticket thread
app.get('/api/tickets/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenant = (c as any).tenant
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const id = c.req.param('id')
  const ticket: any = await db.prepare(
    `SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?`
  ).bind(id, tenant.id).first()
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  const messages = await db.prepare(
    `SELECT * FROM ticket_messages WHERE ticket_id = ? AND is_internal = 0 ORDER BY created_at ASC`
  ).bind(id).all()
  return c.json({ ticket, messages: messages.results })
})

// POST /api/tickets/:id/reply — tenant adds a reply to ticket
app.post('/api/tickets/:id/reply', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenant = (c as any).tenant
  if (!tenant) return c.json({ error: 'Tenant not found' }, 404)
  const id = c.req.param('id')
  const ticket: any = await db.prepare(
    `SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?`
  ).bind(id, tenant.id).first()
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
  if (ticket.status === 'closed') return c.json({ error: 'Ticket is closed' }, 400)
  const { message, sender_name } = await c.req.json()
  if (!message) return c.json({ error: 'message is required' }, 400)
  await db.prepare(
    `INSERT INTO ticket_messages (ticket_id, sender_type, sender_name, message) VALUES (?, 'tenant', ?, ?)`
  ).bind(id, sender_name || tenant.company_name, message).run()
  await db.prepare(
    `UPDATE support_tickets SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(id).run()
  // Alert super admin of tenant reply
  await sendTicketEmail(c.env, {
    to: 'admin@clockinproof.com',
    subject: `💬 Reply on [${ticket.ticket_number}] — ${ticket.subject}`,
    html: `<div style="font-family:sans-serif;max-width:560px;padding:24px">
      <h2 style="color:#4F46E5">Tenant Replied to Ticket</h2>
      <p><strong>Ticket:</strong> ${ticket.ticket_number} — ${ticket.subject}</p>
      <p><strong>From:</strong> ${tenant.company_name}</p>
      <p style="background:#f8fafc;padding:12px;border-radius:8px;border-left:4px solid #4F46E5">${message}</p>
      <p><a href="https://app.clockinproof.com/super" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Reply in Super Admin</a></p>
    </div>`
  })
  return c.json({ success: true })
})

// ── Super Admin ticket routes ────────────────────────────────────────────────

// GET /api/super/tickets — all tickets across all tenants
app.get('/api/super/tickets', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const status = c.req.query('status') || ''
  const where = status ? `WHERE t.status = '${status}'` : `WHERE t.status != 'deleted'`
  try {
    const tickets = await db.prepare(`
      SELECT t.*, ten.company_name, ten.slug as tenant_slug,
        (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) as message_count,
        (SELECT m.created_at FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1) as last_reply_at
      FROM support_tickets t
      JOIN tenants ten ON ten.id = t.tenant_id
      ${where}
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        t.updated_at DESC
    `).all()
    // Summary counts
    const counts: any = await db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress_count,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved_count,
        SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed_count,
        SUM(CASE WHEN priority='urgent' AND status NOT IN ('closed','resolved') THEN 1 ELSE 0 END) as urgent_open
      FROM support_tickets WHERE status != 'deleted'
    `).first()
    return c.json({ tickets: tickets.results, counts })
  } catch(err: any) {
    return c.json({ error: err?.message }, 500)
  }
})

// GET /api/super/tickets/:id — full ticket thread
app.get('/api/super/tickets/:id', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const ticket: any = await db.prepare(`
    SELECT t.*, ten.company_name, ten.slug as tenant_slug, ten.admin_email as tenant_email
    FROM support_tickets t
    JOIN tenants ten ON ten.id = t.tenant_id
    WHERE t.id = ?
  `).bind(id).first()
  if (!ticket) return c.json({ error: 'Not found' }, 404)
  const messages = await db.prepare(
    `SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC`
  ).bind(id).all()
  return c.json({ ticket, messages: messages.results })
})

// POST /api/super/tickets/:id/reply — super admin replies
app.post('/api/super/tickets/:id/reply', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { message, is_internal } = await c.req.json()
  if (!message) return c.json({ error: 'message is required' }, 400)
  const ticket: any = await db.prepare(`
    SELECT t.*, ten.admin_email as tenant_email, ten.company_name
    FROM support_tickets t
    JOIN tenants ten ON ten.id = t.tenant_id
    WHERE t.id = ?
  `).bind(id).first()
  if (!ticket) return c.json({ error: 'Not found' }, 404)
  const isInternal = is_internal ? 1 : 0
  await db.prepare(
    `INSERT INTO ticket_messages (ticket_id, sender_type, sender_name, message, is_internal) VALUES (?, 'admin', 'ClockInProof Support', ?, ?)`
  ).bind(id, message, isInternal).run()
  await db.prepare(
    `UPDATE support_tickets SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(id).run()
  // Email tenant (only if not an internal note)
  if (!isInternal && ticket.tenant_email) {
    await sendTicketEmail(c.env, {
      to: ticket.tenant_email,
      subject: `[${ticket.ticket_number}] Update on your support ticket — ${ticket.subject}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#4F46E5;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:18px">💬 Update on Your Ticket</h2>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:24px">
          <p style="color:#374151">Hi <strong>${ticket.company_name}</strong>,</p>
          <p style="color:#374151">Our support team has replied to your ticket <strong style="font-family:monospace">${ticket.ticket_number}</strong>:</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid #4F46E5;border-radius:0 8px 8px 0;padding:16px;margin:16px 0">
            <p style="margin:0;color:#1e293b">${message.replace(/\n/g, '<br>')}</p>
          </div>
          <p style="color:#374151"><strong>Ticket:</strong> ${ticket.subject}</p>
          <p style="color:#374151"><strong>Status:</strong> <span style="color:#d97706;font-weight:700">IN PROGRESS</span></p>
          <p style="color:#6b7280;font-size:12px;margin-top:24px">Reply to this email to add more information to your ticket.<br>— ClockInProof Support Team</p>
        </div>
      </div>`
    })
  }
  return c.json({ success: true })
})

// PUT /api/super/tickets/:id/status — change ticket status (resolve/close/reopen)
app.put('/api/super/tickets/:id/status', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { status, resolution_note } = await c.req.json()
  const validStatuses = ['open', 'in_progress', 'resolved', 'closed']
  if (!validStatuses.includes(status)) return c.json({ error: 'Invalid status' }, 400)
  const ticket: any = await db.prepare(`
    SELECT t.*, ten.admin_email as tenant_email, ten.company_name
    FROM support_tickets t JOIN tenants ten ON ten.id = t.tenant_id WHERE t.id = ?
  `).bind(id).first()
  if (!ticket) return c.json({ error: 'Not found' }, 404)
  const resolvedAt = (status === 'resolved' || status === 'closed') ? 'CURRENT_TIMESTAMP' : 'NULL'
  await db.prepare(
    `UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP, resolved_at = ${resolvedAt} WHERE id = ?`
  ).bind(status, id).run()
  // Add system message to thread
  const statusLabels: Record<string, string> = {
    open: '🔓 Ticket re-opened',
    in_progress: '🔄 Ticket marked In Progress',
    resolved: '✅ Ticket marked Resolved',
    closed: '🔒 Ticket Closed'
  }
  const sysMsg = statusLabels[status] + (resolution_note ? `: ${resolution_note}` : '')
  await db.prepare(
    `INSERT INTO ticket_messages (ticket_id, sender_type, sender_name, message, is_internal) VALUES (?, 'system', 'ClockInProof Support', ?, 0)`
  ).bind(id, sysMsg).run()
  // Email tenant on resolve/close
  if ((status === 'resolved' || status === 'closed') && ticket.tenant_email) {
    const isClosed = status === 'closed'
    await sendTicketEmail(c.env, {
      to: ticket.tenant_email,
      subject: `[${ticket.ticket_number}] ${isClosed ? 'Ticket Closed' : 'Issue Resolved'} — ${ticket.subject}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:${isClosed ? '#059669' : '#0891b2'};padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:18px">${isClosed ? '🔒 Ticket Closed' : '✅ Issue Resolved'}</h2>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 12px 12px;padding:24px">
          <p style="color:#374151">Hi <strong>${ticket.company_name}</strong>,</p>
          <p style="color:#374151">Your support ticket <strong style="font-family:monospace">${ticket.ticket_number}</strong> has been <strong>${isClosed ? 'closed' : 'resolved'}</strong>.</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0">
            <p style="margin:0 0 8px"><strong>Subject:</strong> ${ticket.subject}</p>
            ${resolution_note ? `<p style="margin:0 0 8px"><strong>Resolution:</strong> ${resolution_note}</p>` : ''}
            <p style="margin:0"><strong>Status:</strong> <span style="color:${isClosed ? '#059669' : '#0891b2'};font-weight:700">${status.toUpperCase()}</span></p>
          </div>
          ${isClosed
            ? `<p style="color:#374151">If this issue returns or you have a new question, please submit a new support ticket from your admin dashboard.</p>`
            : `<p style="color:#374151">If the issue persists or you have further questions, reply to this email and we will continue to assist you.</p>`
          }
          <p style="color:#6b7280;font-size:12px;margin-top:24px">Thank you for using ClockInProof.<br>— ClockInProof Support Team</p>
        </div>
      </div>`
    })
  }
  // Email tenant on reopen confirmation
  if (status === 'open' && ticket.tenant_email) {
    await sendTicketEmail(c.env, {
      to: ticket.tenant_email,
      subject: `[${ticket.ticket_number}] Ticket Re-opened — ${ticket.subject}`,
      html: `<div style="font-family:sans-serif;max-width:560px;padding:24px">
        <h2 style="color:#4F46E5">Ticket Re-opened</h2>
        <p>Your ticket <strong>${ticket.ticket_number}</strong> has been re-opened and is back in our queue.</p>
        <p>— ClockInProof Support Team</p>
      </div>`
    })
  }
  return c.json({ success: true })
})

// PUT /api/super/tickets/:id/priority — update priority
app.put('/api/super/tickets/:id/priority', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const id = c.req.param('id')
  const { priority } = await c.req.json()
  if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return c.json({ error: 'Invalid priority' }, 400)
  await db.prepare(
    `UPDATE support_tickets SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(priority, id).run()
  return c.json({ success: true })
})

// ─── STAT PAY RULES (province/state minimums) ─────────────────────────────────
const STAT_PAY_RULES: Record<string, { multiplier: number; name: string }> = {
  // Canadian Provinces
  'CA-ON': { multiplier: 1.5, name: 'Ontario' },
  'CA-BC': { multiplier: 1.5, name: 'British Columbia' },
  'CA-AB': { multiplier: 1.5, name: 'Alberta' },
  'CA-QC': { multiplier: 1.0, name: 'Quebec' },         // Regular pay if given day off
  'CA-MB': { multiplier: 1.5, name: 'Manitoba' },
  'CA-SK': { multiplier: 1.5, name: 'Saskatchewan' },
  'CA-NS': { multiplier: 1.5, name: 'Nova Scotia' },
  'CA-NB': { multiplier: 1.5, name: 'New Brunswick' },
  'CA-PE': { multiplier: 1.5, name: 'Prince Edward Island' },
  'CA-NL': { multiplier: 2.0, name: 'Newfoundland & Labrador' },
  'CA-NT': { multiplier: 1.5, name: 'Northwest Territories' },
  'CA-YT': { multiplier: 1.5, name: 'Yukon' },
  'CA-NU': { multiplier: 1.5, name: 'Nunavut' },
  // US States (federal FLSA: no mandatory premium, but common practice is 1.5x)
  'US-CA': { multiplier: 1.5, name: 'California' },
  'US-NY': { multiplier: 1.5, name: 'New York' },
  'US-TX': { multiplier: 1.5, name: 'Texas' },
  'US-FL': { multiplier: 1.5, name: 'Florida' },
  'US-WA': { multiplier: 1.5, name: 'Washington' },
  'US-OR': { multiplier: 1.5, name: 'Oregon' },
  'US-MA': { multiplier: 1.5, name: 'Massachusetts' },
  'US-IL': { multiplier: 1.5, name: 'Illinois' },
}

// ─── HOLIDAYS API ─────────────────────────────────────────────────────────────

// Fetch public holidays from Nager.Date API (free, no key needed)
app.get('/api/holidays/:year', async (c) => {
  const year = c.req.param('year')
  const db = c.env.DB

  // Get country + province from settings
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  settingsRaw.results.forEach((s: any) => { settings[s.key] = s.value })

  const country = settings.country_code || 'CA'
  const province = settings.province_code || 'ON'

  try {
    // Nager.Date public API - completely free
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'ClockInProof/1.0' }
    })

    if (!res.ok) throw new Error('Holiday API failed')
    const allHolidays: any[] = await res.json()

    // Filter: national holidays + province-specific ones
    const filtered = allHolidays.filter((h: any) => {
      if (!h.counties || h.counties.length === 0) return true  // national
      // Check if this province is in the counties list
      const provCode = `${country}-${province}`
      return h.counties.some((c: string) => c === provCode || c === province)
    })

    // Add stat pay info
    const provinceKey = `${country}-${province}`
    const statRule = STAT_PAY_RULES[provinceKey] || { multiplier: 1.5, name: province }

    const holidays = filtered.map((h: any) => ({
      date: h.date,
      name: h.localName || h.name,
      global: !h.counties || h.counties.length === 0,
      stat_multiplier: statRule.multiplier,
      province: statRule.name
    }))

    return c.json({ holidays, country, province, year, stat_rule: statRule })
  } catch (e) {
    // Return empty on failure (don't crash the app)
    return c.json({ holidays: [], country, province, year, error: 'Could not fetch holidays' })
  }
})

// Get calendar data for a month (sessions + holidays + schedule info)
app.get('/api/calendar/:year/:month', async (c) => {
  const db = c.env.DB
  const year = parseInt(c.req.param('year'))
  const month = parseInt(c.req.param('month')) // 1-12
  const worker_id = c.req.query('worker_id')

  // Get settings
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  settingsRaw.results.forEach((s: any) => { settings[s.key] = s.value })

  // Get sessions for the month
  const startDate = `${year}-${String(month).padStart(2,'0')}-01`
  const endDate = `${year}-${String(month).padStart(2,'0')}-31`

  let sessQuery = `
    SELECT s.*, w.name as worker_name, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
  `
  const params: any[] = [startDate, endDate]

  if (worker_id) {
    sessQuery += ' AND s.worker_id = ?'
    params.push(parseInt(worker_id))
  }

  sessQuery += ' ORDER BY s.clock_in_time ASC'

  const sessions = await db.prepare(sessQuery).bind(...params).all()

  // Group sessions by date
  const sessionsByDate: Record<string, any[]> = {}
  sessions.results.forEach((s: any) => {
    const d = s.clock_in_time.split('T')[0].split(' ')[0]
    if (!sessionsByDate[d]) sessionsByDate[d] = []
    sessionsByDate[d].push(s)
  })

  // Work schedule from settings
  const workDays = (settings.work_days || '1,2,3,4,5').split(',').map(Number) // 0=Sun,1=Mon...6=Sat
  const workStart = settings.work_start || '08:00'
  const workEnd = settings.work_end || '16:00'
  const paidHours = parseFloat(settings.paid_hours_per_day || '7.5')

  return c.json({
    year, month,
    sessions_by_date: sessionsByDate,
    settings: {
      country: settings.country_code || 'CA',
      province: settings.province_code || 'ON',
      work_days: workDays,
      work_start: workStart,
      work_end: workEnd,
      paid_hours_per_day: paidHours,
      stat_pay_multiplier: parseFloat(settings.stat_pay_multiplier || '1.5')
    }
  })
})

// ─── PAYROLL REPORT API ───────────────────────────────────────────────────────
app.get('/api/payroll/:year/:month', async (c) => {
  const db = c.env.DB
  const tenantId = await resolveTenantId(c, db)
  const year = parseInt(c.req.param('year'))
  const month = parseInt(c.req.param('month'))
  const worker_id = c.req.query('worker_id')

  const startDate = `${year}-${String(month).padStart(2,'0')}-01`
  const endDate = new Date(year, month, 0).toISOString().split('T')[0] // last day of month

  let query = `
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    AND s.status = 'completed' AND s.tenant_id = ?
  `
  const params: any[] = [startDate, endDate, tenantId]
  if (worker_id) { query += ' AND s.worker_id = ?'; params.push(parseInt(worker_id)) }
  query += ' ORDER BY w.name, s.clock_in_time ASC'

  const sessions = await db.prepare(query).bind(...params).all()

  // Group by worker
  const byWorker: Record<string, any> = {}
  sessions.results.forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) {
      byWorker[wid] = { worker_id: wid, name: s.worker_name, phone: s.worker_phone, hourly_rate: s.hourly_rate, sessions: [], total_hours: 0, total_regular: 0, total_stat: 0, total_pay: 0 }
    }
    byWorker[wid].sessions.push(s)
    byWorker[wid].total_hours += s.total_hours || 0
    byWorker[wid].total_pay += s.earnings || 0
  })

  return c.json({ payroll: Object.values(byWorker), period: `${year}-${String(month).padStart(2,'0')}`, start: startDate, end: endDate })
})

// ─── WEEKLY EXPORT API ────────────────────────────────────────────────────────

// Helper: get Mon–Fri week boundaries for a given date
function getWeekBounds(refDate?: Date): { start: string; end: string; label: string } {
  const d = refDate ? new Date(refDate) : new Date()
  // Find most-recent Monday
  const day = d.getUTCDay()                      // 0=Sun … 6=Sat
  const diffToMon = day === 0 ? -6 : 1 - day    // days back to Monday
  const mon = new Date(d)
  mon.setUTCDate(d.getUTCDate() + diffToMon)
  mon.setUTCHours(0, 0, 0, 0)
  // Friday of same week
  const fri = new Date(mon)
  fri.setUTCDate(mon.getUTCDate() + 4)
  fri.setUTCHours(23, 59, 59, 999)

  const fmt = (dt: Date) => dt.toISOString().split('T')[0]
  const label = `Week of ${fmt(mon)} to ${fmt(fri)}`
  return { start: fmt(mon), end: fmt(fri), label }
}

// GET /api/export/weekly?week=YYYY-MM-DD   (week= is any date in the desired week)
// Returns full JSON with sessions + GPS pings per worker
app.get('/api/export/weekly', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const weekParam   = c.req.query('week')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds = workerId ? [bounds.start, bounds.end, tenantId, workerId] : [bounds.start, bounds.end, tenantId]

  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
      AND s.tenant_id = ?
      ${workerFilter}
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...sessionBinds).all()

  // GPS pings for every session in the week
  const pings = await db.prepare(`
    SELECT lp.*
    FROM location_pings lp
    JOIN sessions s ON lp.session_id = s.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
      AND s.tenant_id = ?
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end, tenantId).all()

  // Index pings by session_id
  const pingsBySession: Record<number, any[]> = {}
  ;(pings.results as any[]).forEach((p: any) => {
    if (!pingsBySession[p.session_id]) pingsBySession[p.session_id] = []
    pingsBySession[p.session_id].push(p)
  })

  // Group sessions by worker
  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) {
      byWorker[wid] = {
        worker_id: wid,
        worker_name: s.worker_name,
        worker_phone: s.worker_phone,
        hourly_rate: s.hourly_rate,
        sessions: [],
        total_hours: 0,
        total_earnings: 0
      }
    }
    const enriched = {
      ...s,
      gps_pings: pingsBySession[s.id] || []
    }
    byWorker[wid].sessions.push(enriched)
    byWorker[wid].total_hours    += s.total_hours || 0
    byWorker[wid].total_earnings += s.earnings    || 0
  })

  return c.json({
    week: bounds,
    generated_at: new Date().toISOString(),
    workers: Object.values(byWorker)
  })
})

// GET /api/export/period?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns JSON for any arbitrary date range — used by QB preview and email
app.get('/api/export/period', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const start       = c.req.query('start') || new Date().toISOString().split('T')[0]
  const end         = c.req.query('end')   || start
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const binds = workerId ? [start, end, workerId] : [start, end]

  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ${workerFilter}
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...binds).all()

  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) {
      byWorker[wid] = { worker_id: wid, worker_name: s.worker_name, worker_phone: s.worker_phone, hourly_rate: s.hourly_rate, sessions: [], total_hours: 0, total_earnings: 0 }
    }
    byWorker[wid].sessions.push(s)
    byWorker[wid].total_hours    += s.total_hours || 0
    byWorker[wid].total_earnings += s.earnings    || 0
  })

  const fmtLabel = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
  return c.json({
    start, end,
    label: `${fmtLabel(start)} – ${fmtLabel(end)}`,
    generated_at: new Date().toISOString(),
    workers: Object.values(byWorker)
  })
})

// GET /api/export/weekly/html?week=YYYY-MM-DD
// Returns a printable HTML proof report
app.get('/api/export/weekly/html', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const tenantId = await resolveTenantId(c, db)
  const weekParam   = c.req.query('week')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds      = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const workerFilter  = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds  = workerId ? [bounds.start, bounds.end, tenantId, workerId] : [bounds.start, bounds.end, tenantId]

  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
      AND s.tenant_id = ?
      ${workerFilter}
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...sessionBinds).all()

  // GPS pings
  const pings = await db.prepare(`
    SELECT lp.*
    FROM location_pings lp
    JOIN sessions s ON lp.session_id = s.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
      AND s.tenant_id = ?
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end, tenantId).all()

  const pingsBySession: Record<number, any[]> = {}
  ;(pings.results as any[]).forEach((p: any) => {
    if (!pingsBySession[p.session_id]) pingsBySession[p.session_id] = []
    pingsBySession[p.session_id].push(p)
  })

  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) byWorker[wid] = {
      worker_name: s.worker_name, worker_phone: s.worker_phone,
      hourly_rate: s.hourly_rate, sessions: [], total_hours: 0, total_earnings: 0
    }
    byWorker[wid].sessions.push({ ...s, gps_pings: pingsBySession[s.id] || [] })
    byWorker[wid].total_hours    += s.total_hours || 0
    byWorker[wid].total_earnings += s.earnings    || 0
  })

  const html = buildWeeklyReportHTML(bounds, settings, Object.values(byWorker))
  return c.html(html)
})

// POST /api/export/email  { week?: 'YYYY-MM-DD', worker_id?: number }
// Sends the weekly report to admin email via Resend (or falls back to preview)
app.post('/api/export/email', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  await ensureSchema(db)

  const body        = await c.req.json().catch(() => ({})) as any
  const weekParam   = body.week
  const workerIdRaw = body.worker_id
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds      = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const adminEmail = settings.admin_email || ''
  const replyTo    = settings.reply_to_email || adminEmail
  if (!adminEmail) {
    return c.json({ error: 'No admin email configured. Go to Settings → General and add your email.' }, 400)
  }

  // Build sessions data — optionally filtered by worker
  const workerFilter  = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds  = workerId ? [bounds.start, bounds.end, workerId] : [bounds.start, bounds.end]

  // Fetch worker name for single-worker subject line
  let workerLabel = 'All Staff'
  if (workerId) {
    const wRow = await db.prepare('SELECT name FROM workers WHERE id = ?').bind(workerId).first() as any
    if (wRow) workerLabel = wRow.name
  }

  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ${workerFilter}
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...sessionBinds).all()

  const pings = await db.prepare(`
    SELECT lp.* FROM location_pings lp
    JOIN sessions s ON lp.session_id = s.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end).all()

  const pingsBySession: Record<number, any[]> = {}
  ;(pings.results as any[]).forEach((p: any) => {
    if (!pingsBySession[p.session_id]) pingsBySession[p.session_id] = []
    pingsBySession[p.session_id].push(p)
  })

  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) byWorker[wid] = {
      worker_name: s.worker_name, worker_phone: s.worker_phone,
      hourly_rate: s.hourly_rate, sessions: [], total_hours: 0, total_earnings: 0
    }
    byWorker[wid].sessions.push({ ...s, gps_pings: pingsBySession[s.id] || [] })
    byWorker[wid].total_hours    += s.total_hours || 0
    byWorker[wid].total_earnings += s.earnings    || 0
  })

  const htmlBody = buildWeeklyReportHTML(bounds, settings, Object.values(byWorker))
  const appName  = settings.app_name || 'ClockInProof'
  const subject  = workerId
    ? `${appName} — Timesheet for ${workerLabel}: ${bounds.label}`
    : `${appName} — Weekly Report: ${bounds.label}`

  // Try Resend API (set RESEND_API_KEY in Cloudflare secrets)
  const resendKey = env.RESEND_API_KEY || ''
  if (resendKey) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `${appName} <reports@clockinproof.com>`,
          reply_to: replyTo || undefined,
          to: [adminEmail],
          subject,
          html: htmlBody
        })
      })
      const result = await resp.json() as any
      if (!resp.ok) {
        return c.json({ error: 'Email service error', detail: result }, 500)
      }
      // Log the send
      await db.prepare(
        `INSERT OR IGNORE INTO settings (key, value) VALUES ('last_weekly_email_sent', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).bind(new Date().toISOString()).run()
      return c.json({ success: true, message: `Report sent to ${adminEmail}`, week: bounds.label, email_id: result.id, worker: workerLabel })
    } catch (e: any) {
      return c.json({ error: 'Failed to send email', detail: e.message }, 500)
    }
  }

  // No email key — return preview URL instead
  return c.json({
    success: false,
    message: 'Email not configured. Add RESEND_API_KEY secret and admin_email in Settings.',
    preview_url: `/api/export/weekly/html?week=${bounds.start}${workerId ? '&worker_id=' + workerId : ''}`,
    week: bounds.label
  }, 200)
})

// GET /api/export/csv?week=YYYY-MM-DD&end=YYYY-MM-DD&worker_id=N
// Returns a CSV file attachment (all staff or a single worker)
app.get('/api/export/csv', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const weekParam   = c.req.query('week')
  const endParam    = c.req.query('end')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds      = getWeekBounds(weekParam ? new Date(weekParam) : undefined)
  if (endParam) bounds.end = endParam   // optional end override for pay-period exports

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds = workerId ? [bounds.start, bounds.end, workerId] : [bounds.start, bounds.end]

  // Filename: per-worker or all-staff
  let filenameWorker = 'all-staff'
  if (workerId) {
    const wRow = await db.prepare('SELECT name FROM workers WHERE id = ?').bind(workerId).first() as any
    if (wRow) filenameWorker = wRow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  }

  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ${workerFilter}
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...sessionBinds).all()

  const pings = await db.prepare(`
    SELECT lp.* FROM location_pings lp
    JOIN sessions s ON lp.session_id = s.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end).all()

  const pingsBySession: Record<number, any[]> = {}
  ;(pings.results as any[]).forEach((p: any) => {
    if (!pingsBySession[p.session_id]) pingsBySession[p.session_id] = []
    pingsBySession[p.session_id].push(p)
  })

  // Row: one per session, with GPS proof summary
  const csvHeader = [
    'Worker', 'Phone', 'Date', 'Day',
    'Clock In', 'Clock Out', 'Hours', 'Rate/hr', 'Earnings',
    'Job Location', 'Job Description',
    'Clock-In GPS (Lat)', 'Clock-In GPS (Lng)', 'Clock-In Address',
    'Clock-Out GPS (Lat)', 'Clock-Out GPS (Lng)', 'Clock-Out Address',
    'GPS Pings Count', 'Status'
  ]

  const escape = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"'

  const rows = (sessions.results as any[]).map((s: any) => {
    const sessionPings = pingsBySession[s.id] || []
    const clockInDate = new Date(s.clock_in_time)
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][clockInDate.getUTCDay()]

    return [
      s.worker_name,
      s.worker_phone,
      clockInDate.toISOString().split('T')[0],
      dayName,
      new Date(s.clock_in_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'ACTIVE',
      (s.total_hours || 0).toFixed(2),
      (s.hourly_rate || 0).toFixed(2),
      (s.earnings || 0).toFixed(2),
      s.job_location || '',
      s.job_description || '',
      s.clock_in_lat  || '',
      s.clock_in_lng  || '',
      s.clock_in_address  || '',
      s.clock_out_lat || '',
      s.clock_out_lng || '',
      s.clock_out_address || '',
      sessionPings.length,
      s.status
    ].map(escape).join(',')
  })

  const csv = [csvHeader.map(escape).join(','), ...rows].join('\n')
  const filename = `clockinproof-${filenameWorker}-${bounds.start}.csv`

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  })
})

// ─── QUICKBOOKS EXPORT ENDPOINTS ─────────────────────────────────────────────
//
// Supports three formats:
//  1. QB Desktop IIF  → GET /api/export/qb-iif?start=YYYY-MM-DD&end=YYYY-MM-DD
//  2. QB Online CSV   → GET /api/export/qb-csv?start=YYYY-MM-DD&end=YYYY-MM-DD
//  3. Generic payroll → GET /api/export/payroll-period?start=&end=
//
// All three accept optional ?worker_id=N for a single worker.
// The pay-period bounds can be derived from the /api/pay-periods helper below.

// ── Helper: compute pay period list ──────────────────────────────────────────
function getPayPeriods(freq: string, anchor: string, count = 13): { start: string; end: string; label: string; payday: string }[] {
  const msDay = 86400000
  const anchorDate = new Date(anchor + 'T00:00:00')
  const days = freq === 'weekly' ? 7 : freq === 'monthly' ? 30 : 14
  const periods: { start: string; end: string; label: string; payday: string }[] = []
  const fmt = (d: Date) => d.toISOString().split('T')[0]
  const fmtLabel = (d: Date) => d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })

  // Find the period that contains today, then go back (count/2) periods
  const today = new Date()
  const msSinceAnchor = today.getTime() - anchorDate.getTime()
  const periodsSinceAnchor = Math.max(0, Math.floor(msSinceAnchor / (days * msDay)))
  const startIndex = Math.max(0, periodsSinceAnchor - Math.floor(count / 2))

  for (let i = startIndex; i < startIndex + count; i++) {
    const pStart = new Date(anchorDate.getTime() + i * days * msDay)
    const pEnd   = new Date(pStart.getTime() + (days - 1) * msDay)
    const payday = new Date(pStart.getTime() + (days - 1) * msDay) // last day = payday
    periods.push({
      start:  fmt(pStart),
      end:    fmt(pEnd),
      payday: fmt(payday),
      label:  `${fmtLabel(pStart)} – ${fmtLabel(pEnd)}`
    })
  }
  return periods
}

// GET /api/pay-periods — returns list of pay periods for the selector UI
app.get('/api/pay-periods', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const rows = await db.prepare("SELECT key,value FROM settings WHERE key IN ('pay_frequency','pay_period_anchor')").all()
  const cfg: Record<string,string> = {}
  ;(rows.results as any[]).forEach((r: any) => { cfg[r.key] = r.value })
  const freq   = cfg.pay_frequency   || 'biweekly'
  const anchor = cfg.pay_period_anchor || '2026-03-06'
  return c.json({ periods: getPayPeriods(freq, anchor, 13), freq, anchor })
})

// ── QB Desktop IIF export ─────────────────────────────────────────────────────
// IIF (Intuit Interchange Format) — tab-separated, imports via File→Utilities→Import→IIF
app.get('/api/export/qb-iif', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const start = c.req.query('start') || new Date().toISOString().split('T')[0]
  const end   = c.req.query('end')   || start
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null

  const settingsRaw = await db.prepare('SELECT key,value FROM settings').all()
  const settings: Record<string,string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })
  const companyName = settings.company_name || settings.app_name || 'ClockInProof'

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const binds = workerId ? [start, end, workerId] : [start, end]

  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ${workerFilter} AND s.status = 'completed'
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...binds).all()

  // Build IIF — QuickBooks Desktop timesheet format
  // TIMERHDR section defines the company & version
  const TAB = '\t'
  const lines: string[] = []

  lines.push('!TIMERHDR' + TAB + 'VER' + TAB + 'REL' + TAB + 'COMPANYNAME' + TAB + 'IMPORTTIMESTAMP' + TAB + 'WORKPHONE')
  lines.push('TIMERHDR'  + TAB + '8'   + TAB + 'R6'  + TAB + companyName   + TAB + new Date().toISOString() + TAB + '')
  lines.push('')

  // TIMEACT — one row per work session
  lines.push('!TIMEACT' + TAB + 'DATE' + TAB + 'EMP' + TAB + 'JOB' + TAB + 'ITEM' + TAB + 'PITEM' + TAB + 'DURATION' + TAB + 'PRATE' + TAB + 'DESC' + TAB + 'BILLABLE')

  ;(sessions.results as any[]).forEach((s: any) => {
    const dateStr = new Date(s.clock_in_time).toISOString().split('T')[0]
    // DURATION in QB IIF format is HH:MM (hours:minutes)
    const totalMins = Math.round((s.total_hours || 0) * 60)
    const hh = Math.floor(totalMins / 60)
    const mm = totalMins % 60
    const duration = `${hh}:${String(mm).padStart(2, '0')}`
    const desc = s.job_location ? `${s.job_location}${s.job_description ? ' — ' + s.job_description : ''}` : (s.job_description || 'Work')

    lines.push([
      'TIMEACT',
      dateStr,
      s.worker_name,          // EMP  — must match QB employee name exactly
      '',                      // JOB  — optional customer:job
      'Regular Pay',           // ITEM — payroll item (must exist in QB)
      '',                      // PITEM
      duration,                // DURATION
      (s.hourly_rate || 0).toFixed(2),  // PRATE
      desc,                    // DESC
      'N'                      // BILLABLE
    ].join(TAB))
  })

  lines.push('')
  lines.push('!ENDOFFILE')

  const iif = lines.join('\r\n')
  const filename = `clockinproof-payroll-${start}-to-${end}.iif`

  return new Response(iif, {
    headers: {
      'Content-Type': 'text/plain',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  })
})

// ── QB Online / Generic Payroll CSV ──────────────────────────────────────────
// QB Online imports a simple CSV with employee, date, regular hours, pay rate
app.get('/api/export/qb-csv', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const start = c.req.query('start') || new Date().toISOString().split('T')[0]
  const end   = c.req.query('end')   || start
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null

  const settingsRaw = await db.prepare('SELECT key,value FROM settings').all()
  const settings: Record<string,string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const binds = workerId ? [start, end, workerId] : [start, end]

  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ${workerFilter} AND s.status = 'completed'
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(...binds).all()

  // Aggregate by worker + date for clean QB import
  const byWorkerDate: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const dateStr = new Date(s.clock_in_time).toISOString().split('T')[0]
    const key = `${s.worker_id}__${dateStr}`
    if (!byWorkerDate[key]) {
      byWorkerDate[key] = {
        employee_name:  s.worker_name,
        employee_phone: s.worker_phone,
        employee_email: s.worker_email || '',
        work_date:      dateStr,
        regular_hours:  0,
        overtime_hours: 0,
        hourly_rate:    s.hourly_rate || 0,
        gross_pay:      0,
        job_location:   s.job_location || '',
        notes:          []
      }
    }
    const dailyHours = s.total_hours || 0
    const stdHours   = Math.min(dailyHours, 8)
    const otHours    = Math.max(0, dailyHours - 8)
    byWorkerDate[key].regular_hours  += stdHours
    byWorkerDate[key].overtime_hours += otHours
    byWorkerDate[key].gross_pay      += s.earnings || 0
    if (s.job_description) byWorkerDate[key].notes.push(s.job_description)
  })

  const esc = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"'

  const headers = [
    'Employee Name', 'Work Date', 'Regular Hours', 'Overtime Hours',
    'Hourly Rate', 'Gross Pay', 'Job Location', 'Notes',
    'Employee Phone', 'Employee Email'
  ]

  const rows = Object.values(byWorkerDate).map((r: any) => [
    r.employee_name,
    r.work_date,
    r.regular_hours.toFixed(2),
    r.overtime_hours.toFixed(2),
    r.hourly_rate.toFixed(2),
    r.gross_pay.toFixed(2),
    r.job_location,
    r.notes.join('; '),
    r.employee_phone,
    r.employee_email
  ].map(esc).join(','))

  // Summary rows per employee (for QB Online payroll import)
  const summary: Record<string, any> = {}
  Object.values(byWorkerDate).forEach((r: any) => {
    if (!summary[r.employee_name]) {
      summary[r.employee_name] = { name: r.employee_name, phone: r.employee_phone, email: r.employee_email, regular: 0, overtime: 0, rate: r.hourly_rate, gross: 0 }
    }
    summary[r.employee_name].regular  += r.regular_hours
    summary[r.employee_name].overtime += r.overtime_hours
    summary[r.employee_name].gross    += r.gross_pay
  })

  const summaryRows = Object.values(summary).map((r: any) => [
    r.name,
    `${start} to ${end}`,
    r.regular.toFixed(2),
    r.overtime.toFixed(2),
    r.rate.toFixed(2),
    r.gross.toFixed(2),
    'PAY PERIOD TOTAL',
    '',
    r.phone,
    r.email
  ].map(esc).join(','))

  const csv = [
    headers.map(esc).join(','),
    ...rows,
    '',
    esc('--- PAY PERIOD SUMMARY ---') + ',,,,,,,,',
    headers.map(esc).join(','),
    ...summaryRows
  ].join('\n')

  const filename = `clockinproof-qb-payroll-${start}-to-${end}.csv`

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`
    }
  })
})

// ── Email QB payroll files to accountant ─────────────────────────────────────
// POST /api/export/email-accountant
// Body: { start, end, format: 'iif'|'csv'|'both', to: email }
app.post('/api/export/email-accountant', async (c) => {
  const db  = c.env.DB
  const env = c.env
  await ensureSchema(db)

  const { start, end, format, to: toEmail } = await c.req.json() as any

  if (!start || !end || !toEmail) {
    return c.json({ error: 'Missing required fields: start, end, to' }, 400)
  }

  const resendKey = (env.RESEND_API_KEY || '').trim()
  if (!resendKey) {
    return c.json({ error: 'Email not configured — add RESEND_API_KEY as a Cloudflare secret' }, 400)
  }

  const settingsRaw2 = await db.prepare('SELECT key,value FROM settings').all()
  const settings2: Record<string,string> = {}
  ;(settingsRaw2.results as any[]).forEach((s: any) => { settings2[s.key] = s.value })
  const companyName = settings2.company_name || settings2.app_name || 'ClockInProof'
  const adminEmail  = settings2.admin_email || ''
  const replyTo2    = settings2.reply_to_email || adminEmail

  // Fetch all sessions for the period
  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.email AS worker_email, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    AND s.status = 'completed'
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(start, end).all()

  // Build per-worker summary
  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) {
      byWorker[wid] = { name: s.worker_name, phone: s.worker_phone, email: s.worker_email || '', rate: s.hourly_rate, regular: 0, overtime: 0, gross: 0, sessions: 0 }
    }
    const h = s.total_hours || 0
    byWorker[wid].regular  += Math.min(h, 8)
    byWorker[wid].overtime += Math.max(0, h - 8)
    byWorker[wid].gross    += s.earnings || 0
    byWorker[wid].sessions++
  })

  const workers = Object.values(byWorker)
  const totalGross = workers.reduce((a: number, w: any) => a + w.gross, 0)
  const totalHours = workers.reduce((a: number, w: any) => a + w.regular + w.overtime, 0)

  // Generate QB CSV content inline for attachment
  const esc = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
  const csvHeaders = ['Employee Name','Work Date','Regular Hours','Overtime Hours','Hourly Rate','Gross Pay','Notes','Employee Phone','Employee Email']

  const dailyRows: string[] = []
  const byWD: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const dateStr = new Date(s.clock_in_time).toISOString().split('T')[0]
    const key = `${s.worker_id}__${dateStr}`
    if (!byWD[key]) byWD[key] = { name: s.worker_name, phone: s.worker_phone, email: s.worker_email||'', date: dateStr, reg: 0, ot: 0, rate: s.hourly_rate, gross: 0, notes: [] }
    const h = s.total_hours || 0
    byWD[key].reg   += Math.min(h, 8)
    byWD[key].ot    += Math.max(0, h - 8)
    byWD[key].gross += s.earnings || 0
    if (s.job_description) byWD[key].notes.push(s.job_description)
  })
  Object.values(byWD).forEach((r: any) => {
    dailyRows.push([r.name, r.date, r.reg.toFixed(2), r.ot.toFixed(2), r.rate.toFixed(2), r.gross.toFixed(2), r.notes.join('; '), r.phone, r.email].map(esc).join(','))
  })
  const summaryRows = workers.map((w: any) => [w.name, `${start} to ${end}`, w.regular.toFixed(2), w.overtime.toFixed(2), w.rate.toFixed(2), w.gross.toFixed(2), 'PAY PERIOD TOTAL', w.phone, w.email].map(esc).join(','))
  const csvContent = [csvHeaders.map(esc).join(','), ...dailyRows, '', esc('--- PAY PERIOD SUMMARY ---') + ',,,,,,,', csvHeaders.map(esc).join(','), ...summaryRows].join('\n')

  // Generate IIF content inline for attachment
  const TAB = '\t'
  const iifLines: string[] = [
    '!TIMERHDR\tVER\tREL\tCOMPANYNAME\tIMPORTTIMESTAMP\tWORKPHONE',
    `TIMERHDR\t8\tR6\t${companyName}\t${new Date().toISOString()}\t`,
    '',
    '!TIMEACT\tDATE\tEMP\tJOB\tITEM\tPITEM\tDURATION\tPRATE\tDESC\tBILLABLE'
  ]
  ;(sessions.results as any[]).forEach((s: any) => {
    const dateStr = new Date(s.clock_in_time).toISOString().split('T')[0]
    const totalMins = Math.round((s.total_hours || 0) * 60)
    const hh = Math.floor(totalMins / 60)
    const mm = totalMins % 60
    const duration = `${hh}:${String(mm).padStart(2,'0')}`
    const desc = s.job_location ? `${s.job_location}${s.job_description ? ' — '+s.job_description : ''}` : (s.job_description||'Work')
    iifLines.push(['TIMEACT', dateStr, s.worker_name, '', 'Regular Pay', '', duration, (s.hourly_rate||0).toFixed(2), desc, 'N'].join(TAB))
  })
  iifLines.push('', '!ENDOFFILE')
  const iifContent = iifLines.join('\r\n')

  // Build attachments list based on format
  const attachments: any[] = []
  const fmt = format || 'both'
  if (fmt === 'csv' || fmt === 'both') {
    attachments.push({
      filename: `payroll-${start}-to-${end}-qb-import.csv`,
      content:  btoa(unescape(encodeURIComponent(csvContent))),
      type:     'text/csv'
    })
  }
  if (fmt === 'iif' || fmt === 'both') {
    attachments.push({
      filename: `payroll-${start}-to-${end}-qb-desktop.iif`,
      content:  btoa(unescape(encodeURIComponent(iifContent))),
      type:     'text/plain'
    })
  }

  // Format period label
  const fmtDate = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })

  // Build email HTML
  const workerRows = workers.map((w: any) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">${w.name}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${(w.regular+w.overtime).toFixed(2)}h</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${w.overtime > 0 ? w.overtime.toFixed(2)+'h OT' : '—'}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:700;color:#166534;">$${w.gross.toFixed(2)}</td>
    </tr>
  `).join('')

  const emailHtml = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f8f9fa;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 32px;">
    <h1 style="color:white;margin:0;font-size:22px;">💼 Payroll Report — ${companyName}</h1>
    <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px;">Pay Period: ${fmtDate(start)} → ${fmtDate(end)}</p>
  </div>
  <div style="padding:28px 32px;">
    <div style="display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;">
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#166534;">$${totalGross.toFixed(2)}</div>
        <div style="font-size:12px;color:#16a34a;margin-top:2px;">Total Gross Pay</div>
      </div>
      <div style="flex:1;min-width:120px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#1e40af;">${totalHours.toFixed(1)}h</div>
        <div style="font-size:12px;color:#3b82f6;margin-top:2px;">Total Hours</div>
      </div>
      <div style="flex:1;min-width:120px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:700;color:#7e22ce;">${workers.length}</div>
        <div style="font-size:12px;color:#9333ea;margin-top:2px;">Employees</div>
      </div>
    </div>
    <h2 style="font-size:15px;color:#374151;margin:0 0 12px;">Employee Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Employee</th>
          <th style="padding:10px 12px;text-align:center;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Hours</th>
          <th style="padding:10px 12px;text-align:center;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Overtime</th>
          <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;">Gross Pay</th>
        </tr>
      </thead>
      <tbody>${workerRows}</tbody>
      <tfoot>
        <tr style="background:#f9fafb;font-weight:700;">
          <td style="padding:12px;border-top:2px solid #e5e7eb;">TOTAL</td>
          <td style="padding:12px;border-top:2px solid #e5e7eb;text-align:center;">${totalHours.toFixed(1)}h</td>
          <td style="padding:12px;border-top:2px solid #e5e7eb;"></td>
          <td style="padding:12px;border-top:2px solid #e5e7eb;text-align:right;color:#166534;font-size:16px;">$${totalGross.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
    <div style="margin-top:24px;padding:16px;background:#fefce8;border:1px solid #fde047;border-radius:10px;font-size:13px;color:#713f12;">
      <strong>📎 Attached Files:</strong><br>
      ${fmt === 'both' || fmt === 'csv' ? `• <strong>payroll-${start}-to-${end}-qb-import.csv</strong> — QuickBooks Online / import-ready CSV<br>` : ''}
      ${fmt === 'both' || fmt === 'iif' ? `• <strong>payroll-${start}-to-${end}-qb-desktop.iif</strong> — QuickBooks Desktop IIF (File → Utilities → Import → IIF)<br>` : ''}
      <br>Employee names in these files must match QuickBooks exactly.
    </div>
  </div>
  <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;text-align:center;">
    Generated by ${companyName} · ClockInProof · ${new Date().toLocaleDateString()}
  </div>
</div>
</body></html>`

  const toList = [{ email: toEmail }]
  if (adminEmail && adminEmail !== toEmail) toList.push({ email: adminEmail })

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `${companyName} Payroll <payroll@clockinproof.com>`,
        reply_to: replyTo2 || undefined,
        to:   toList,
        subject: `Payroll Report: ${start} to ${end} — ${companyName}`,
        html: emailHtml,
        attachments
      })
    })

    const respData = await resp.json() as any
    if (resp.ok && respData.id) {
      return c.json({
        success: true,
        email_id: respData.id,
        sent_to: toList.map((t: any) => t.email),
        workers: workers.length,
        total_gross: totalGross,
        formats_attached: attachments.map((a: any) => a.filename)
      })
    } else {
      return c.json({ error: respData.message || 'Email send failed', resend_error: respData }, 500)
    }
  } catch (e: any) {
    return c.json({ error: `Email error: ${e.message}` }, 500)
  }
})

// ─── QUICKBOOKS OAUTH 2.0 INTEGRATION ────────────────────────────────────────
//
// Flow:
//  1. Admin enters Client ID + Secret in Settings → saved to DB
//  2. Admin clicks "Connect to QuickBooks" → GET /api/qb/connect → redirects to Intuit
//  3. Intuit redirects to GET /api/qb/callback?code=…&realmId=… → exchanges for tokens
//  4. Tokens saved in settings; qb_connected = '1'
//  5. Admin maps workers → QB employees via GET /api/qb/employees + POST /api/qb/map
//  6. On any pay period: POST /api/qb/sync → pushes TimeActivity for each session
//
// Intuit OAuth 2.0 endpoints:
//  Auth:    https://appcenter.intuit.com/connect/oauth2
//  Token:   https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
//  Revoke:  https://developer.api.intuit.com/v2/oauth2/tokens/revoke
// ─────────────────────────────────────────────────────────────────────────────

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2'
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const QB_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
const QB_SCOPES = 'com.intuit.quickbooks.accounting'

function qbApiBase(environment: string) {
  return environment === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com/v3/company'
    : 'https://quickbooks.api.intuit.com/v3/company'
}

async function loadQbSettings(db: D1Database): Promise<Record<string, string>> {
  const raw = await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'qb_%'`).all()
  const s: Record<string, string> = {}
  ;(raw.results as any[]).forEach((r: any) => { s[r.key] = r.value })
  return s
}

async function saveSetting(db: D1Database, key: string, value: string) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, value).run()
}

async function refreshQbToken(db: D1Database, qb: Record<string, string>): Promise<string | null> {
  if (!qb.qb_client_id || !qb.qb_refresh_token) return null
  const creds = btoa(`${qb.qb_client_id}:${qb.qb_client_secret}`)
  try {
    const res = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: qb.qb_refresh_token
      }).toString()
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const expires = Date.now() + (data.expires_in || 3600) * 1000
    await saveSetting(db, 'qb_access_token', data.access_token)
    await saveSetting(db, 'qb_refresh_token', data.refresh_token || qb.qb_refresh_token)
    await saveSetting(db, 'qb_token_expires', String(expires))
    return data.access_token
  } catch { return null }
}

async function getQbAccessToken(db: D1Database, qb: Record<string, string>): Promise<string | null> {
  if (!qb.qb_access_token) return null
  const expires = parseInt(qb.qb_token_expires || '0')
  if (Date.now() > expires - 60000) return refreshQbToken(db, qb)
  return qb.qb_access_token
}

// ── GET /api/qb/status ─────────────────────────────────────────────────────
app.get('/api/qb/status', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const qb = await loadQbSettings(db)
  const connected = qb.qb_connected === '1' && !!qb.qb_realm_id
  const expires = parseInt(qb.qb_token_expires || '0')
  return c.json({
    connected,
    token_valid: connected && Date.now() < expires,
    token_expires: expires ? new Date(expires).toISOString() : null,
    realm_id: qb.qb_realm_id || null,
    company_name: qb.qb_company_name || null,
    environment: qb.qb_environment || 'production',
    has_client_id: !!qb.qb_client_id,
    has_client_secret: !!qb.qb_client_secret
  })
})

// ── GET /api/qb/connect — redirect to Intuit OAuth ────────────────────────
app.get('/api/qb/connect', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const qb = await loadQbSettings(db)
  if (!qb.qb_client_id || !qb.qb_client_secret) {
    return c.json({ error: 'QuickBooks Client ID and Secret must be saved in Settings first.' }, 400)
  }
  const hostRow = await db.prepare(`SELECT value FROM settings WHERE key = 'admin_host'`).first() as any
  const adminHost = hostRow?.value || ''
  if (!adminHost) return c.json({ error: 'Admin host URL must be configured in Settings.' }, 400)

  const redirectUri = `${adminHost}/api/qb/callback`
  const state = btoa(JSON.stringify({ ts: Date.now() }))
  const params = new URLSearchParams({
    client_id: qb.qb_client_id,
    scope: QB_SCOPES,
    redirect_uri: redirectUri,
    response_type: 'code',
    state
  })
  return c.redirect(`${QB_AUTH_URL}?${params.toString()}`)
})

// ── GET /api/qb/callback — Intuit redirects here after approval ────────────
app.get('/api/qb/callback', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { code, realmId, error: oauthErr } = c.req.query() as any

  const closeScript = (success: boolean, msg: string) => `<html><head><title>QuickBooks</title></head><body>
    <script>
      if(window.opener){window.opener.postMessage({type:'qb_oauth',success:${success},msg:'${msg.replace(/'/g,"\\'")}'},'*');}
      setTimeout(()=>window.close(),2000);
    </script>
    <p style="font-family:sans-serif;text-align:center;padding:40px;font-size:18px;">
      ${success ? '✅' : '❌'} ${msg}
    </p>
  </body></html>`

  if (oauthErr) return c.html(closeScript(false, 'Connection cancelled.'))

  const qb = await loadQbSettings(db)
  if (!qb.qb_client_id) return c.html(closeScript(false, 'QB credentials not configured.'))

  const hostRow = await db.prepare(`SELECT value FROM settings WHERE key = 'admin_host'`).first() as any
  const adminHost = hostRow?.value || ''
  const redirectUri = `${adminHost}/api/qb/callback`
  const creds = btoa(`${qb.qb_client_id}:${qb.qb_client_secret}`)

  try {
    const tokenRes = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString()
    })
    if (!tokenRes.ok) return c.html(closeScript(false, 'Token exchange failed. Check credentials.'))

    const td: any = await tokenRes.json()
    const expires = Date.now() + (td.expires_in || 3600) * 1000

    await saveSetting(db, 'qb_access_token', td.access_token)
    await saveSetting(db, 'qb_refresh_token', td.refresh_token || '')
    await saveSetting(db, 'qb_token_expires', String(expires))
    await saveSetting(db, 'qb_realm_id', realmId)
    await saveSetting(db, 'qb_connected', '1')

    // Fetch company name
    try {
      const env = qb.qb_environment || 'production'
      const qbBase = qbApiBase(env)
      const cr = await fetch(`${qbBase}/${realmId}/companyinfo/${realmId}?minorversion=70`, {
        headers: { 'Authorization': `Bearer ${td.access_token}`, 'Accept': 'application/json' }
      })
      if (cr.ok) {
        const cd: any = await cr.json()
        await saveSetting(db, 'qb_company_name', cd?.CompanyInfo?.CompanyName || '')
      }
    } catch { /* non-fatal */ }

    return c.html(closeScript(true, 'QuickBooks connected! You can close this window.'))
  } catch (e: any) {
    return c.html(closeScript(false, `Error: ${e.message}`))
  }
})

// ── POST /api/qb/disconnect ────────────────────────────────────────────────
app.post('/api/qb/disconnect', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const qb = await loadQbSettings(db)
  if (qb.qb_access_token && qb.qb_client_id) {
    const creds = btoa(`${qb.qb_client_id}:${qb.qb_client_secret}`)
    try {
      await fetch(QB_REVOKE_URL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: qb.qb_access_token }).toString()
      })
    } catch { /* ignore */ }
  }
  for (const key of ['qb_connected','qb_access_token','qb_refresh_token','qb_token_expires','qb_realm_id','qb_company_name']) {
    await saveSetting(db, key, key === 'qb_token_expires' ? '0' : '')
  }
  return c.json({ success: true, message: 'Disconnected from QuickBooks' })
})

// ── GET /api/qb/employees — list QB employees for mapping ─────────────────
app.get('/api/qb/employees', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const qb = await loadQbSettings(db)
  if (qb.qb_connected !== '1') return c.json({ error: 'Not connected to QuickBooks' }, 400)
  const token = await getQbAccessToken(db, qb)
  if (!token) return c.json({ error: 'QB token expired — please reconnect' }, 401)

  try {
    const qbBase = qbApiBase(qb.qb_environment || 'production')
    const query = encodeURIComponent('SELECT * FROM Employee WHERE Active = true MAXRESULTS 200')
    const res = await fetch(`${qbBase}/${qb.qb_realm_id}/query?query=${query}&minorversion=70`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    })
    if (!res.ok) return c.json({ error: `QB API error ${res.status}` }, 500)
    const data: any = await res.json()
    const employees = (data?.QueryResponse?.Employee || []).map((e: any) => ({
      id: e.Id,
      name: `${e.GivenName || ''} ${e.FamilyName || ''}`.trim() || e.DisplayName,
      display_name: e.DisplayName
    }))
    const maps = await db.prepare(
      `SELECT m.worker_id, m.qb_employee_id, m.qb_employee_name, w.name as worker_name
       FROM qb_employee_map m JOIN workers w ON w.id = m.worker_id`
    ).all()
    return c.json({ employees, mappings: maps.results })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── GET /api/qb/workers — our workers with QB mapping status ──────────────
app.get('/api/qb/workers', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const workers = await db.prepare(
    `SELECT w.id, w.name, w.phone, w.job_title,
       m.qb_employee_id, m.qb_employee_name
     FROM workers w
     LEFT JOIN qb_employee_map m ON m.worker_id = w.id
     WHERE w.active = 1 ORDER BY w.name`
  ).all()
  return c.json({ workers: workers.results })
})

// ── POST /api/qb/map — save worker→QB employee mapping ───────────────────
app.post('/api/qb/map', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { worker_id, qb_employee_id, qb_employee_name } = await c.req.json()
  if (!worker_id || !qb_employee_id) return c.json({ error: 'worker_id and qb_employee_id required' }, 400)
  await db.prepare(
    `INSERT INTO qb_employee_map (worker_id, qb_employee_id, qb_employee_name) VALUES (?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET qb_employee_id=excluded.qb_employee_id, qb_employee_name=excluded.qb_employee_name`
  ).bind(worker_id, qb_employee_id, qb_employee_name).run()
  return c.json({ success: true })
})

// ── DELETE /api/qb/map/:worker_id ─────────────────────────────────────────
app.delete('/api/qb/map/:worker_id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  await db.prepare(`DELETE FROM qb_employee_map WHERE worker_id = ?`).bind(c.req.param('worker_id')).run()
  return c.json({ success: true })
})

// ── POST /api/qb/sync — push TimeActivity records to QB ───────────────────
// Body: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', dry_run?: boolean }
app.post('/api/qb/sync', async (c) => {
  try {
  const db = c.env.DB
  await ensureSchema(db)
  const qb = await loadQbSettings(db)
  if (qb.qb_connected !== '1') return c.json({ error: 'Not connected to QuickBooks' }, 400)
  const token = await getQbAccessToken(db, qb)
  if (!token) return c.json({ error: 'QB token expired — please reconnect' }, 401)

  const body = await c.req.json()
  const { start, end, dry_run = false } = body
  if (!start || !end) return c.json({ error: 'start and end dates required' }, 400)

  const sessions = await db.prepare(
    `SELECT s.id, s.worker_id, s.clock_in_time, s.hours_worked, s.job_location, s.session_type,
       w.name as worker_name, w.hourly_rate,
       m.qb_employee_id, m.qb_employee_name
     FROM sessions s
     JOIN workers w ON w.id = s.worker_id
     LEFT JOIN qb_employee_map m ON m.worker_id = s.worker_id
     WHERE s.clock_out_time IS NOT NULL
       AND date(s.clock_in_time) >= ? AND date(s.clock_in_time) <= ?
       AND s.hours_worked > 0
     ORDER BY s.clock_in_time`
  ).bind(start, end).all()

  const qbBase = qbApiBase(qb.qb_environment || 'production')
  const results: any[] = []
  let pushed = 0, errors = 0
  const unmapped: string[] = []

  for (const s of sessions.results as any[]) {
    if (!s.qb_employee_id) {
      if (!unmapped.includes(s.worker_name)) unmapped.push(s.worker_name)
      results.push({ session_id: s.id, worker: s.worker_name, status: 'skipped', reason: 'No QB employee mapped' })
      continue
    }
    const dateStr = new Date(s.clock_in_time).toISOString().split('T')[0]
    const totalMins = Math.round((s.hours_worked || 0) * 60)
    const hrs = Math.floor(totalMins / 60)
    const mins = totalMins % 60

    const payload = {
      TxnDate: dateStr,
      NameOf: 'Employee',
      EmployeeRef: { value: s.qb_employee_id, name: s.qb_employee_name || s.worker_name },
      Hours: hrs,
      Minutes: mins,
      Description: `ClockInProof: ${s.job_location || 'Regular work'} (Session #${s.id})`,
      BillableStatus: 'NotBillable',
      Taxable: false
    }

    if (dry_run) {
      results.push({ session_id: s.id, worker: s.worker_name, status: 'dry_run', payload })
      pushed++
      continue
    }

    try {
      const res = await fetch(`${qbBase}/${qb.qb_realm_id}/timeactivity?minorversion=70`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      })
      if (res.ok) {
        const d: any = await res.json()
        results.push({ session_id: s.id, worker: s.worker_name, status: 'success', qb_id: d?.TimeActivity?.Id })
        pushed++
      } else {
        const err = await res.text()
        results.push({ session_id: s.id, worker: s.worker_name, status: 'error', error: err })
        errors++
      }
    } catch (e: any) {
      results.push({ session_id: s.id, worker: s.worker_name, status: 'error', error: e.message })
      errors++
    }
  }

  if (!dry_run) {
    const workerSet = new Set((sessions.results as any[]).filter((s: any) => s.qb_employee_id).map((s: any) => s.worker_id))
    await db.prepare(
      `INSERT INTO qb_sync_log (pay_period_start, pay_period_end, worker_count, time_activity_count, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(start, end, workerSet.size, pushed, errors > 0 ? 'partial' : 'success',
      unmapped.length ? `Unmapped: ${unmapped.join(', ')}` : null).run()
  }

  return c.json({ success: true, dry_run, period: `${start} → ${end}`,
    total_sessions: (sessions.results as any[]).length, pushed, errors, unmapped_workers: unmapped, results })
  } catch (e: any) {
    return c.json({ error: e.message || 'Sync failed', details: String(e) }, 500)
  }
})

// ── GET /api/qb/sync-log ──────────────────────────────────────────────────
app.get('/api/qb/sync-log', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const logs = await db.prepare(`SELECT * FROM qb_sync_log ORDER BY synced_at DESC LIMIT 20`).all()
  return c.json({ logs: logs.results })
})

// ─── SCHEDULED WEEKLY EMAIL (Cloudflare Cron Trigger) ─────────────────────────
async function runWeeklyEmailJob(db: D1Database, env: any) {
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const adminEmail = settings.admin_email || ''
  const replyTo    = settings.reply_to_email || adminEmail
  const appName = settings.app_name || 'ClockInProof'
  if (!adminEmail || !env.RESEND_API_KEY) return  // silently skip if not configured

  const bounds  = getWeekBounds()  // current week
  const sessions = await db.prepare(`
    SELECT s.*, w.name AS worker_name, w.phone AS worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(bounds.start, bounds.end).all()

  const pings = await db.prepare(`
    SELECT lp.* FROM location_pings lp
    JOIN sessions s ON lp.session_id = s.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end).all()

  const pingsBySession: Record<number, any[]> = {}
  ;(pings.results as any[]).forEach((p: any) => {
    if (!pingsBySession[p.session_id]) pingsBySession[p.session_id] = []
    pingsBySession[p.session_id].push(p)
  })

  const byWorker: Record<string, any> = {}
  ;(sessions.results as any[]).forEach((s: any) => {
    const wid = s.worker_id
    if (!byWorker[wid]) byWorker[wid] = {
      worker_name: s.worker_name, worker_phone: s.worker_phone,
      hourly_rate: s.hourly_rate, sessions: [], total_hours: 0, total_earnings: 0
    }
    byWorker[wid].sessions.push({ ...s, gps_pings: pingsBySession[s.id] || [] })
    byWorker[wid].total_hours    += s.total_hours || 0
    byWorker[wid].total_earnings += s.earnings    || 0
  })

  const htmlBody = buildWeeklyReportHTML(bounds, settings, Object.values(byWorker))
  const subject  = `${appName} — Weekly Report: ${bounds.label}`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${appName} <reports@clockinproof.com>`,
      reply_to: replyTo || undefined,
      to: [adminEmail],
      subject,
      html: htmlBody
    })
  })

  await db.prepare(
    `INSERT OR IGNORE INTO settings (key,value) VALUES('last_weekly_email_sent',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ).bind(new Date().toISOString()).run()
}

// ─── HTML REPORT BUILDER ──────────────────────────────────────────────────────
function buildWeeklyReportHTML(
  bounds: { start: string; end: string; label: string },
  settings: Record<string, string>,
  workers: any[]
): string {
  const appName = settings.app_name || 'ClockInProof'
  const generatedAt = new Date().toLocaleString('en-CA', { dateStyle: 'full', timeStyle: 'short' })

  const totalHours    = workers.reduce((s, w) => s + w.total_hours, 0)
  const totalEarnings = workers.reduce((s, w) => s + w.total_earnings, 0)
  const totalSessions = workers.reduce((s, w) => s + w.sessions.length, 0)

  const workerSections = workers.map(w => {
    const sessionRows = w.sessions.map((s: any) => {
      const clockInDate  = new Date(s.clock_in_time)
      const clockOutDate = s.clock_out_time ? new Date(s.clock_out_time) : null
      const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][clockInDate.getUTCDay()]
      const dateStr = clockInDate.toISOString().split('T')[0]

      const pings: any[] = s.gps_pings || []

      // GPS proof: clock-in, each ping, clock-out
      const allGPSPoints: Array<{time:string, lat:number|null, lng:number|null, label:string, note:string}> = []

      if (s.clock_in_lat) {
        allGPSPoints.push({
          time: clockInDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          lat: s.clock_in_lat, lng: s.clock_in_lng,
          label: '🟢 Clock In',
          note: s.clock_in_address || ''
        })
      }

      // Pings excluded from export — only Clock In / Clock Out shown
      // Summary: total pings count only
      const pingCount = pings.length

      if (s.clock_out_lat && clockOutDate) {
        allGPSPoints.push({
          time: clockOutDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          lat: s.clock_out_lat, lng: s.clock_out_lng,
          label: '🔴 Clock Out',
          note: s.clock_out_address || ''
        })
      }

      const gpsProofHTML = allGPSPoints.length > 0
        ? `<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:8px;">
            <thead>
              <tr style="background:#f1f5f9;text-align:left;">
                <th style="padding:5px 8px;border:1px solid #e2e8f0;">Time</th>
                <th style="padding:5px 8px;border:1px solid #e2e8f0;">Event</th>
                <th style="padding:5px 8px;border:1px solid #e2e8f0;">GPS Coordinates</th>
                <th style="padding:5px 8px;border:1px solid #e2e8f0;">Map Link</th>
              </tr>
            </thead>
            <tbody>
              ${allGPSPoints.map(pt => `
                <tr>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;font-weight:600;white-space:nowrap;">${pt.time}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;">${pt.label}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;font-family:monospace;">${pt.lat !== null ? `${(pt.lat as number).toFixed(6)}, ${(pt.lng as number).toFixed(6)}` : '—'}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;">${pt.lat !== null ? `<a href="https://maps.google.com/?q=${pt.lat},${pt.lng}" style="color:#2563eb;">View Map</a>` : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
        : `<p style="font-size:11px;color:#94a3b8;margin-top:6px;font-style:italic;">⚠ No GPS data recorded for this shift</p>`

      const totalGPSPoints = allGPSPoints.length + pingCount
      const gpsStatus = totalGPSPoints > 0
        ? `<span style="background:#dcfce7;color:#166534;font-size:10px;padding:2px 7px;border-radius:999px;font-weight:600;">✓ GPS Verified (${pingCount} ping${pingCount !== 1 ? 's' : ''} logged)</span>`
        : `<span style="background:#fef9c3;color:#854d0e;font-size:10px;padding:2px 7px;border-radius:999px;font-weight:600;">⚠ No GPS</span>`

      return `
        <div style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
          <!-- Shift header -->
          <div style="background:#f8fafc;padding:10px 14px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
            <div>
              <span style="font-weight:700;color:#1e293b;">${dayName}, ${dateStr}</span>
              <span style="margin-left:12px;color:#64748b;font-size:12px;">
                ${clockInDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                →
                ${clockOutDate ? clockOutDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '<span style="color:#16a34a;font-weight:600;">Still Active</span>'}
              </span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${gpsStatus}
              <span style="background:#ede9fe;color:#5b21b6;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:600;">${(s.total_hours||0).toFixed(2)}h</span>
              <span style="background:#dcfce7;color:#166534;font-size:11px;padding:2px 8px;border-radius:999px;font-weight:700;">$${(s.earnings||0).toFixed(2)}</span>
              <span style="background:${s.status==='active'?'#bbf7d0':'#f1f5f9'};color:${s.status==='active'?'#065f46':'#64748b'};font-size:10px;padding:2px 8px;border-radius:999px;">${s.status.toUpperCase()}</span>
            </div>
          </div>
          <!-- Job info -->
          <div style="padding:10px 14px;border-bottom:1px solid #f1f5f9;">
            ${s.job_location ? `<p style="margin:0 0 4px;font-size:12px;"><span style="color:#64748b;">📍 Location:</span> <strong>${s.job_location}</strong></p>` : ''}
            ${s.job_description ? `<p style="margin:0;font-size:12px;color:#475569;"><span style="color:#64748b;">🔧 Tasks:</span> ${s.job_description}</p>` : ''}
          </div>
          <!-- GPS summary (no per-ping rows) -->
          <div style="padding:10px 14px;">
            ${gpsProofHTML}
          </div>
        </div>`
    }).join('')

    return `
      <div style="margin-bottom:32px;page-break-inside:avoid;">
        <!-- Worker header -->
        <div style="background:#1e40af;color:white;padding:12px 18px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <p style="margin:0;font-size:16px;font-weight:700;">${w.worker_name}</p>
            <p style="margin:2px 0 0;font-size:12px;opacity:0.8;">${w.worker_phone} · $${(w.hourly_rate||0).toFixed(2)}/hr</p>
          </div>
          <div style="text-align:right;">
            <p style="margin:0;font-size:14px;font-weight:700;">${w.total_hours.toFixed(2)} hrs</p>
            <p style="margin:2px 0 0;font-size:16px;font-weight:800;">$${w.total_earnings.toFixed(2)}</p>
          </div>
        </div>
        <!-- Sessions -->
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:14px;">
          <p style="margin:0 0 10px;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;">${w.sessions.length} shift${w.sessions.length !== 1 ? 's' : ''} this week</p>
          ${sessionRows}
        </div>
      </div>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${appName} — ${bounds.label}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1e293b; background: #f8fafc; margin: 0; padding: 0; }
    .page { max-width: 900px; margin: 0 auto; padding: 32px 24px; background: white; }
    @media print {
      body { background: white; }
      .no-print { display: none !important; }
      .page { padding: 16px; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Letterhead -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:20px;border-bottom:3px solid #1e40af;">
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div style="width:40px;height:40px;background:#1e40af;border-radius:10px;display:flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:18px;">⏱</span>
        </div>
        <span style="font-size:22px;font-weight:800;color:#1e40af;">${appName}</span>
      </div>
      <p style="margin:0;color:#64748b;font-size:12px;">Weekly Work Hours & GPS Location Report</p>
    </div>
    <div style="text-align:right;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Generated: ${generatedAt}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600;">${bounds.label}</p>
      ${settings.city ? `<p style="margin:2px 0 0;font-size:11px;color:#94a3b8;">${settings.city}, ${settings.province_code || ''} ${settings.country_code || ''}</p>` : ''}
    </div>
  </div>

  <!-- Summary Banner -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px;">
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;text-align:center;">
      <p style="margin:0;font-size:22px;font-weight:800;color:#1e40af;">${workers.length}</p>
      <p style="margin:3px 0 0;font-size:11px;color:#3b82f6;">Workers</p>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;text-align:center;">
      <p style="margin:0;font-size:22px;font-weight:800;color:#166534;">${totalSessions}</p>
      <p style="margin:3px 0 0;font-size:11px;color:#22c55e;">Shifts</p>
    </div>
    <div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:12px;text-align:center;">
      <p style="margin:0;font-size:22px;font-weight:800;color:#6b21a8;">${totalHours.toFixed(1)}h</p>
      <p style="margin:3px 0 0;font-size:11px;color:#a855f7;">Total Hours</p>
    </div>
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:12px;text-align:center;">
      <p style="margin:0;font-size:22px;font-weight:800;color:#854d0e;">$${totalEarnings.toFixed(2)}</p>
      <p style="margin:3px 0 0;font-size:11px;color:#eab308;">Total Payroll</p>
    </div>
  </div>

  <!-- Print / Download buttons -->
  <div class="no-print" style="margin-bottom:20px;display:flex;gap:10px;">
    <button onclick="window.print()" style="background:#1e40af;color:white;border:none;padding:10px 20px;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600;">🖨 Print / Save as PDF</button>
    <a href="/api/export/csv?week=${bounds.start}" style="background:#166534;color:white;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;display:inline-block;">📥 Download CSV</a>
  </div>

  <!-- GPS Legend -->
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:24px;font-size:11px;color:#64748b;">
    <strong style="color:#374151;">GPS Proof Guide:</strong>
    &nbsp;🟢 Clock In = GPS when worker started &nbsp;|&nbsp;
    📍 Ping = Auto GPS recorded every 5 min during shift &nbsp;|&nbsp;
    🔴 Clock Out = GPS when worker finished &nbsp;|&nbsp;
    Each coordinate links directly to Google Maps
  </div>

  ${workers.length === 0
    ? `<div style="text-align:center;padding:48px;color:#94a3b8;">
        <p style="font-size:48px;margin:0;">📭</p>
        <p style="margin:12px 0 0;font-size:16px;font-weight:600;">No shifts recorded this week</p>
       </div>`
    : workerSections
  }

  <!-- Footer -->
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;font-size:10px;color:#94a3b8;">
    <p style="margin:0;">${appName} · Auto-generated weekly report · ${bounds.label}</p>
    <p style="margin:4px 0 0;">GPS coordinates are timestamped and verifiable via Google Maps links above.</p>
  </div>

</div>
</body>
</html>`
}

// ─── SUBDOMAIN ROUTING ────────────────────────────────────────────────────────
// Reads the Host header and routes:
//   app.clockinproof.com   → Worker clock-in app
//   admin.clockinproof.com → Admin dashboard
//   clockinproof.com / www → Marketing landing page
//   localhost / sandbox    → fallback: path-based routing (/admin = admin, / = worker)

function getSubdomain(c: any): string {
  const host = c.req.header('host') || ''
  const parts = host.split('.')
  // Only treat as subdomain if it's a real domain (ends in .com/.io/.ai etc)
  // e.g. app.clockinproof.com → ['app','clockinproof','com'] → 'app'
  // e.g. 3000-xxxxx.sandbox.novita.ai → NOT a real subdomain → return ''
  const knownSubs = ['app', 'admin', 'www', 'superadmin', 'super']
  if (parts.length >= 3 && knownSubs.includes(parts[0].toLowerCase())) {
    return parts[0].toLowerCase()
  }
  // Tenant subdomain (e.g. acme.clockinproof.com)
  if (parts.length >= 3 && parts[1] === 'clockinproof') {
    return parts[0].toLowerCase()
  }
  return ''
}

// ─── MAIN PAGES ───────────────────────────────────────────────────────────────

// Root route — subdomain-aware for production, landing page for sandbox/direct
app.get('/', async (c) => {
  // Resolve subdomain — check x-forwarded-host first (Cloudflare proxy), then host
  const rawHost = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(':')[0].toLowerCase()
  // Extract subdomain directly from host header as bulletproof fallback
  const directSub = rawHost.endsWith('.clockinproof.com')
    ? rawHost.replace('.clockinproof.com', '')
    : ''
  const sub = getSubdomain(c) || directSub

  if (sub === 'admin') return c.html(getAdminHTML())
  if (sub === 'app')   return c.html(getWorkerHTML())
  if (sub === 'super' || sub === 'superadmin') return c.html(getSuperAdminHTML())
  // Tenant subdomain — e.g. acme.clockinproof.com → smart landing: worker OR admin
  const reserved = ['admin', 'app', 'www', 'superadmin', 'super', 'api', 'mail', '']
  if (sub && !reserved.includes(sub)) {
    const db = c.env.DB
    await ensureSchema(db)
    const tenant = await getTenantBySlug(db, sub) as any
    if (tenant && tenant.status === 'active') {
      const logoHtml = tenant.logo_url
        ? `<img src="${tenant.logo_url}" alt="${tenant.company_name}" class="h-14 w-auto object-contain mx-auto mb-2">`
        : `<div class="w-14 h-14 rounded-2xl bg-indigo-600 flex items-center justify-center mx-auto mb-2 text-white text-2xl font-black">${(tenant.company_name||'C')[0].toUpperCase()}</div>`
      return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${tenant.company_name} — ClockInProof</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="manifest" href="/manifest.json"/>
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
</head>
<body class="bg-gray-950 min-h-screen flex items-center justify-center px-4">
  <div class="w-full max-w-sm text-center">
    <!-- Logo / company initial -->
    ${logoHtml}
    <h1 class="text-2xl font-black text-white mb-1">${tenant.company_name}</h1>
    <p class="text-gray-400 text-sm mb-10">Powered by <span class="text-indigo-400 font-semibold">ClockInProof</span></p>

    <!-- Worker clock-in -->
    <a href="/app" class="flex items-center justify-between w-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-2xl px-6 py-5 mb-4 transition group shadow-lg shadow-indigo-900/40">
      <div class="text-left">
        <p class="font-bold text-lg leading-tight">Clock In / Clock Out</p>
        <p class="text-indigo-200 text-sm mt-0.5">For workers — track your time</p>
      </div>
      <i class="fas fa-clock text-2xl text-indigo-200 group-hover:scale-110 transition-transform"></i>
    </a>

    <!-- Admin panel -->
    <a href="/admin" class="flex items-center justify-between w-full bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-white rounded-2xl px-6 py-5 transition group shadow-lg shadow-gray-900/40 border border-gray-700">
      <div class="text-left">
        <p class="font-bold text-lg leading-tight">Admin Panel</p>
        <p class="text-gray-400 text-sm mt-0.5">For managers — view sessions &amp; workers</p>
      </div>
      <i class="fas fa-shield-alt text-2xl text-gray-400 group-hover:scale-110 transition-transform"></i>
    </a>

    <p class="text-gray-600 text-xs mt-8">© ${new Date().getFullYear()} ClockInProof</p>
  </div>
</body>
</html>`)
    }
    return c.html(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>Company not found</h2>
      <p>The company <strong>${sub}</strong> does not exist or is inactive.</p>
      <a href="https://clockinproof.com">← Back to ClockInProof</a>
    </body></html>`, 404)
  }
  // www.clockinproof.com or clockinproof.com → marketing/pricing page
  return c.html(getLandingHTML())
})

// Worker app — primary path used in sandbox AND sent to workers as invite link
app.get('/app', async (c) => {
  const rawHost = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(':')[0].toLowerCase()
  const directSub = rawHost.endsWith('.clockinproof.com') ? rawHost.replace('.clockinproof.com', '') : ''
  const sub = getSubdomain(c) || directSub
  const reserved = ['admin', 'app', 'www', 'superadmin', 'super', 'api', 'mail', '']
  if (sub && !reserved.includes(sub)) {
    const db = c.env.DB
    await ensureSchema(db)
    const tenant = await getTenantBySlug(db, sub) as any
    if (tenant && tenant.status === 'active') return c.html(getWorkerHTML(tenant))
  }
  return c.html(getWorkerHTML())
})

// Admin dashboard — accessible via /admin path OR admin.clockinproof.com subdomain
app.get('/admin', async (c) => {
  const rawHost = (c.req.header('x-forwarded-host') || c.req.header('host') || '').split(':')[0].toLowerCase()
  const directSub = rawHost.endsWith('.clockinproof.com') ? rawHost.replace('.clockinproof.com', '') : ''
  const sub = getSubdomain(c) || directSub
  const reserved = ['admin', 'app', 'www', 'superadmin', 'super', 'api', 'mail', '']
  if (sub && !reserved.includes(sub)) {
    const db = c.env.DB
    await ensureSchema(db)
    const tenant = await getTenantBySlug(db, sub) as any
    if (tenant && tenant.status === 'active') return c.html(getAdminHTML())
  }
  return c.html(getAdminHTML())
})

// Super Admin portal — accessible via super.clockinproof.com (subdomain handled above in '/' route)
// Also accessible via /super path as fallback (e.g. during DNS propagation or direct URL access)
app.get('/super', (c) => {
  return c.html(getSuperAdminHTML())
})

// Marketing landing page — accessible via root / OR /landing
app.get('/landing', (c) => {
  return c.html(getLandingHTML())
})

// ─── FREE 60-DAY TRIAL — 3-STEP VERIFIED ONBOARDING ─────────────────────────
// Step 1: /free-trial         → email + company + phone → send 6-digit code
// Step 2: /free-trial/verify  → enter code
// Step 3: /free-trial/setup   → full form gated behind verified token
// All leads captured at Step 1 in signup_leads table

app.get('/free-trial', (c) => { return c.html(getFreeTrialStep1HTML()) })
app.get('/free-trial/verify', (c) => { return c.html(getFreeTrialStep2HTML()) })
app.get('/free-trial/setup', (c) => { return c.html(getFreeTrialStep3HTML()) })

// POST /api/free-trial/start — capture lead + send 6-digit auth code
app.post('/api/free-trial/start', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json() as any
  const email = (body.email || '').trim().toLowerCase()
  const phone = (body.phone || '').trim()
  const company_name = (body.company_name || '').trim()
  const utm_source = (body.utm_source || '').trim()
  const utm_medium = (body.utm_medium || '').trim()
  const utm_campaign = (body.utm_campaign || '').trim()

  if (!email) return c.json({ error: 'Email is required' }, 400)
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return c.json({ error: 'Please enter a valid email address' }, 400)
  if (!phone) return c.json({ error: 'Phone number is required for SMS verification' }, 400)
  if (!company_name) return c.json({ error: 'Company name is required' }, 400)

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || ''

  const existing = await db.prepare(`SELECT id FROM signup_leads WHERE email = ? AND converted = 0`).bind(email).first() as any
  if (existing) {
    await db.prepare(`UPDATE signup_leads SET phone=?, company_name=?, auth_code=?, code_expires_at=?, code_verified=0, utm_source=?, utm_medium=?, utm_campaign=? WHERE id=?`)
      .bind(phone, company_name, code, expiresAt, utm_source, utm_medium, utm_campaign, existing.id).run()
  } else {
    await db.prepare(`INSERT INTO signup_leads (email, phone, company_name, auth_code, code_expires_at, utm_source, utm_medium, utm_campaign, ip) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(email, phone, company_name, code, expiresAt, utm_source, utm_medium, utm_campaign, ip).run()
  }

  const resendKey = ((c.env as any).RESEND_API_KEY || '').trim()
  const twilioSid  = ((c.env as any).TWILIO_ACCOUNT_SID || '').trim()
  const twilioAuth = ((c.env as any).TWILIO_AUTH_TOKEN || '').trim()
  const twilioFrom = ((c.env as any).TWILIO_MESSAGING_SERVICE || (c.env as any).TWILIO_FROM_NUMBER || '').trim()
  const errors: string[] = []

  if (resendKey) {
    const er = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ClockInProof <alerts@clockinproof.com>',
        to: [email],
        subject: `Your ClockInProof verification code: ${code}`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#030712;color:#f9fafb;border-radius:16px">
          <div style="text-align:center;margin-bottom:28px">
            <div style="display:inline-block;background:#4F46E5;color:#fff;font-weight:900;font-size:18px;padding:10px 20px;border-radius:10px">ClockIn<span style="color:#a5b4fc">Proof</span></div>
          </div>
          <h2 style="color:#f9fafb;margin:0 0 8px;font-size:22px">Your verification code</h2>
          <p style="color:#9ca3af;margin:0 0 28px">Hi ${company_name} — enter this code to continue your free trial setup.</p>
          <div style="background:#1e1b4b;border:2px solid #4f46e5;border-radius:16px;padding:28px;text-align:center;margin-bottom:28px">
            <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#a5b4fc">${code}</div>
            <p style="color:#6b7280;font-size:13px;margin:12px 0 0">Expires in 15 minutes</p>
          </div>
          <p style="color:#6b7280;font-size:12px;text-align:center">If you did not request this, you can safely ignore this email.</p>
        </div>`
      })
    }).catch(() => null)
    if (!er || !er.ok) errors.push('email')
  } else { errors.push('email_no_key') }

  if (twilioSid && twilioAuth && twilioFrom) {
    const cleanPhone = phone.replace(/[^\d+]/g, '')
    const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : '+1' + cleanPhone.replace(/\D/g, '')
    const smsBody = `Your ClockInProof code is ${code}. Valid 15 min.`
    const smsParams = new URLSearchParams({ To: formattedPhone, From: twilioFrom, Body: smsBody })
    const sr = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(twilioSid + ':' + twilioAuth), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: smsParams.toString()
    }).catch(() => null)
    if (!sr || !sr.ok) errors.push('sms')
  } else { errors.push('sms_no_key') }

  return c.json({ success: true, sent_email: !errors.includes('email'), sent_sms: !errors.includes('sms') })
})

// POST /api/free-trial/verify-code — verify the 6-digit code
app.post('/api/free-trial/verify-code', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { email, code } = await c.req.json() as any
  if (!email || !code) return c.json({ error: 'Email and code are required' }, 400)
  const lead = await db.prepare(`SELECT * FROM signup_leads WHERE email = ? AND converted = 0 ORDER BY created_at DESC LIMIT 1`)
    .bind(email.trim().toLowerCase()).first() as any
  if (!lead) return c.json({ error: 'No pending verification found for this email' }, 404)
  if (lead.auth_code !== String(code).trim()) return c.json({ error: 'Incorrect code — please try again' }, 400)
  if (new Date(lead.code_expires_at) < new Date()) return c.json({ error: 'Code expired — go back and request a new one' }, 400)
  await db.prepare(`UPDATE signup_leads SET code_verified=1, verified_at=CURRENT_TIMESTAMP WHERE id=?`).bind(lead.id).run()
  const token = btoa(`${lead.id}:${email.trim().toLowerCase()}:${Date.now()}`)
  return c.json({ success: true, token, company_name: lead.company_name, email: lead.email, phone: lead.phone })
})

// POST /api/free-trial — Step 3: create tenant (requires verified token)
app.post('/api/free-trial', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const body = await c.req.json() as any
  const { company_name, slug, admin_email, admin_pin, company_address, phone, verify_token } = body

  if (!verify_token) return c.json({ error: 'Verification required — please complete email/SMS verification first' }, 401)
  let leadId: number
  try {
    const decoded = atob(verify_token)
    const parts = decoded.split(':')
    leadId = parseInt(parts[0])
    const tokenEmail = parts[1]
    const tokenTime = parseInt(parts[2])
    if (tokenEmail !== admin_email?.trim().toLowerCase()) return c.json({ error: 'Email mismatch' }, 401)
    if (Date.now() - tokenTime > 2 * 60 * 60 * 1000) return c.json({ error: 'Session expired — please start again' }, 401)
  } catch { return c.json({ error: 'Invalid verification token' }, 401) }

  const lead = await db.prepare(`SELECT * FROM signup_leads WHERE id = ? AND code_verified = 1`).bind(leadId).first() as any
  if (!lead) return c.json({ error: 'Please verify your email/phone before creating your account' }, 401)

  if (!company_name?.trim()) return c.json({ error: 'Company name is required' }, 400)
  if (!slug?.trim())         return c.json({ error: 'Subdomain is required' }, 400)
  if (!admin_email?.trim())  return c.json({ error: 'Admin email is required' }, 400)
  if (!admin_pin?.trim())    return c.json({ error: 'PIN is required' }, 400)
  if (!phone?.trim())        return c.json({ error: 'Phone number is required' }, 400)
  if (!/^\d{4,8}$/.test(admin_pin.trim())) return c.json({ error: 'PIN must be 4-8 digits' }, 400)

  const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').substring(0, 40)
  const reserved = ['admin','app','www','superadmin','super','api','mail','staging','clockinproof','support','free-trial','signup']
  if (reserved.includes(cleanSlug)) return c.json({ error: 'That subdomain is reserved' }, 400)
  const existing = await db.prepare(`SELECT id FROM tenants WHERE slug = ?`).bind(cleanSlug).first()
  if (existing) return c.json({ error: `"${cleanSlug}" is already taken` }, 409)

  const trialEndsAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.prepare(`INSERT INTO tenants (slug,company_name,company_address,admin_email,admin_pin,plan,status,max_workers,trial_ends_at) VALUES (?,?,?,?,?,'trial','trial',25,?)`)
    .bind(cleanSlug, company_name.trim(), company_address?.trim() || '', admin_email.trim().toLowerCase(), admin_pin.trim(), trialEndsAt).run()
  const tenantId = (result.meta as any).last_row_id

  const defaults: [string, string][] = [
    ['app_name', company_name.trim()],['country_code','CA'],['province_code','ON'],
    ['timezone','America/Toronto'],['work_start','08:00'],['work_end','17:00'],
    ['break_morning_min','15'],['break_lunch_min','30'],['break_afternoon_min','15'],
    ['paid_hours_per_day','7.5'],['work_days','1,2,3,4,5'],['stat_pay_multiplier','1.5'],
    ['pay_frequency','biweekly'],['geofence_radius_meters','300'],
    ['gps_fraud_check','1'],['auto_clockout_enabled','1'],
    ['max_shift_hours','12'],['away_warning_min','30'],
    ['company_name', company_name.trim()],['admin_email', admin_email.trim()],
    ['admin_phone', phone?.trim() || ''],['show_pay_to_workers','1'],
  ]
  for (const [key, value] of defaults) {
    await db.prepare(`INSERT OR IGNORE INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)`).bind(tenantId, key, value).run()
  }

  await db.prepare(`UPDATE signup_leads SET converted=1, tenant_id=?, converted_at=CURRENT_TIMESTAMP WHERE id=?`).bind(tenantId, leadId).run()

  const resendKey = ((c.env as any).RESEND_API_KEY || '').trim()
  if (resendKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ClockInProof <alerts@clockinproof.com>',
        to: [admin_email.trim()],
        subject: `Your 60-Day Free Trial is Ready — ClockInProof`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#030712;color:#f9fafb;border-radius:16px">
          <div style="text-align:center;margin-bottom:24px"><div style="display:inline-block;background:#4F46E5;color:#fff;font-weight:900;font-size:18px;padding:10px 20px;border-radius:10px">ClockIn<span style="color:#a5b4fc">Proof</span></div></div>
          <h2 style="color:#f9fafb;margin:0 0 8px">Welcome, ${company_name.trim()}!</h2>
          <p style="color:#9ca3af;margin:0 0 24px">Your 60-day free trial is live. No credit card needed.</p>
          <div style="background:#1e1b4b;border:1px solid #312e81;border-radius:12px;padding:20px;margin-bottom:24px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:14px">Admin Dashboard</td><td style="padding:6px 0;font-weight:600"><a href="https://admin.clockinproof.com" style="color:#818cf8">admin.clockinproof.com</a></td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:14px">Worker App</td><td style="padding:6px 0;font-weight:600"><a href="https://${cleanSlug}.clockinproof.com" style="color:#818cf8">${cleanSlug}.clockinproof.com</a></td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:14px">Your Email</td><td style="padding:6px 0;font-weight:600">${admin_email.trim()}</td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:14px">Admin PIN</td><td style="padding:6px 0;font-weight:600;font-size:20px;letter-spacing:6px">${admin_pin.trim()}</td></tr>
              <tr><td style="padding:6px 0;color:#9ca3af;font-size:14px">Trial Ends</td><td style="padding:6px 0;font-weight:600;color:#4ade80">${new Date(trialEndsAt).toLocaleDateString('en-CA',{year:'numeric',month:'long',day:'numeric'})}</td></tr>
            </table>
          </div>
          <div style="text-align:center"><a href="https://admin.clockinproof.com" style="background:#4F46E5;color:#fff;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;display:inline-block;font-size:16px">Open Admin Dashboard</a></div>
        </div>`
      })
    }).catch(() => {})
  }

  return c.json({ success: true, tenant_id: tenantId, slug: cleanSlug, trial_ends_at: trialEndsAt,
    admin_url: 'https://admin.clockinproof.com', worker_url: `https://${cleanSlug}.clockinproof.com` })
})

// GET /api/super/leads — super admin view of all signup leads
app.get('/api/super/leads', async (c) => {
  if (!verifySuperToken(c)) return c.json({ error: 'Unauthorized' }, 401)
  const db = c.env.DB
  await ensureSchema(db)
  const rows = await db.prepare(`SELECT l.*, t.company_name as tenant_company FROM signup_leads l LEFT JOIN tenants t ON t.id = l.tenant_id ORDER BY l.created_at DESC LIMIT 300`).all()
  return c.json({ leads: rows.results })
})
function getFreeTrialStep1HTML(): string {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Start Free Trial — ClockInProof</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#030712;color:#f9fafb;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
    .card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:32px}
    .inp{width:100%;padding:14px 16px;background:#1f2937;border:1px solid #374151;border-radius:12px;color:#f9fafb;font-size:15px;outline:none;transition:border .15s}
    .inp:focus{border-color:#4f46e5}
    .btn-primary{width:100%;padding:15px;background:#4f46e5;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:8px}
    .btn-primary:hover:not(:disabled){background:#4338ca}
    .btn-primary:disabled{opacity:.6;cursor:not-allowed}
    .err{display:none;background:#450a0a;border:1px solid #dc2626;border-radius:10px;padding:12px 16px;font-size:14px;color:#fca5a5;margin-bottom:16px}
    .logo{display:inline-block;background:#4F46E5;color:#fff;font-weight:900;font-size:17px;padding:9px 18px;border-radius:10px;text-decoration:none}
    .logo span{color:#a5b4fc}
    .step-bar{display:flex;gap:6px;margin-bottom:28px}
    .step-dot{flex:1;height:4px;border-radius:2px;background:#1f2937}
    .step-dot.done{background:#4f46e5}
    .step-dot.active{background:#818cf8}
    label{display:block;font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    select.inp option{background:#1f2937}
  </style>

</head><body>
<nav style="padding:16px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between">
  <a href="/" class="logo">ClockIn<span>Proof</span></a>
  <span style="font-size:13px;color:#6b7280">Already have an account? <a href="https://admin.clockinproof.com" style="color:#818cf8">Sign in</a></span>
</nav>
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 65px);padding:24px">
  <div style="width:100%;max-width:460px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="display:inline-flex;align-items:center;gap:6px;background:#052e16;border:1px solid #166534;color:#4ade80;font-size:13px;font-weight:600;padding:6px 14px;border-radius:20px;margin-bottom:16px">
        <i class="fas fa-gift"></i> 60 Days Free — No Credit Card
      </div>
      <h1 style="font-size:26px;font-weight:900;margin-bottom:6px">Start your free trial</h1>
      <p style="color:#6b7280;font-size:14px">We'll send a verification code to confirm your identity</p>
    </div>
    <div class="card">
      <div class="step-bar"><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div></div>
      <p style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:20px">Step 1 of 3 — Identity Verification</p>
      <div class="err" id="err"></div>
      <form id="form" style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label>Company Name *</label>
          <input id="company" class="inp" type="text" placeholder="e.g. Ottawa Flooring Co." required autocomplete="organization"/>
        </div>
        <div>
          <label>Your Email *</label>
          <input id="email" class="inp" type="email" placeholder="you@company.com" required autocomplete="email"/>
        </div>
        <div>
          <label>Mobile Phone * <span style="font-weight:400;text-transform:none;color:#6b7280;font-size:11px">(verification code sent here)</span></label>
          <input id="phone" class="inp" type="tel" placeholder="+1 613 555 0100" required autocomplete="tel"/>
        </div>
        <button type="submit" class="btn-primary" id="btn">
          <i class="fas fa-paper-plane"></i> Send Verification Code
        </button>
      </form>
      <p style="text-align:center;font-size:12px;color:#374151;margin-top:16px"><i class="fas fa-lock" style="margin-right:4px"></i>No credit card · No commitment · Cancel anytime</p>
    </div>
  </div>
</div>
<script>
document.getElementById('form').addEventListener('submit', async function(e) {
  e.preventDefault()
  const err = document.getElementById('err')
  const btn = document.getElementById('btn')
  err.style.display = 'none'
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Sending code...'
  const params = new URLSearchParams(window.location.search)
  try {
    const r = await fetch('/api/free-trial/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        company_name: document.getElementById('company').value.trim(),
        email: document.getElementById('email').value.trim(),
        phone: document.getElementById('phone').value.trim(),
        utm_source: params.get('utm_source') || '',
        utm_medium: params.get('utm_medium') || '',
        utm_campaign: params.get('utm_campaign') || ''
      })
    })
    const d = await r.json()
    if (d.success) {
      sessionStorage.setItem('trial_email', document.getElementById('email').value.trim())
      sessionStorage.setItem('trial_company', document.getElementById('company').value.trim())
      sessionStorage.setItem('trial_phone', document.getElementById('phone').value.trim())
      window.location.href = '/free-trial/verify'
    } else {
      err.textContent = d.error || 'Something went wrong'
      err.style.display = 'block'
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Verification Code'
    }
  } catch(ex) {
    err.textContent = 'Connection error — please try again'
    err.style.display = 'block'
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Verification Code'
  }
})
</script></body></html>`
}

function getFreeTrialStep2HTML(): string {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Verify Code — ClockInProof</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#030712;color:#f9fafb;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
    .card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:32px}
    .inp{width:100%;padding:14px 16px;background:#1f2937;border:1px solid #374151;border-radius:12px;color:#f9fafb;font-size:15px;outline:none;transition:border .15s}
    .inp:focus{border-color:#4f46e5}
    .btn-primary{width:100%;padding:15px;background:#4f46e5;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:8px}
    .btn-primary:hover:not(:disabled){background:#4338ca}
    .btn-primary:disabled{opacity:.6;cursor:not-allowed}
    .err{display:none;background:#450a0a;border:1px solid #dc2626;border-radius:10px;padding:12px 16px;font-size:14px;color:#fca5a5;margin-bottom:16px}
    .logo{display:inline-block;background:#4F46E5;color:#fff;font-weight:900;font-size:17px;padding:9px 18px;border-radius:10px;text-decoration:none}
    .logo span{color:#a5b4fc}
    .step-bar{display:flex;gap:6px;margin-bottom:28px}
    .step-dot{flex:1;height:4px;border-radius:2px;background:#1f2937}
    .step-dot.done{background:#4f46e5}
    .step-dot.active{background:#818cf8}
    label{display:block;font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    select.inp option{background:#1f2937}
  </style>

  <style>
    .code-inputs{display:flex;gap:10px;justify-content:center;margin-bottom:8px}
    .code-inputs input{width:52px;height:64px;text-align:center;font-size:26px;font-weight:900;background:#1f2937;border:2px solid #374151;border-radius:12px;color:#f9fafb;outline:none;transition:border .15s}
    .code-inputs input:focus{border-color:#4f46e5}
  </style>
</head><body>
<nav style="padding:16px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center">
  <a href="/free-trial" class="logo">ClockIn<span>Proof</span></a>
</nav>
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 65px);padding:24px">
  <div style="width:100%;max-width:420px">
    <div style="text-align:center;margin-bottom:28px">
      <div style="width:64px;height:64px;background:#1e1b4b;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;border:2px solid #4f46e5">
        <i class="fas fa-shield-alt" style="font-size:24px;color:#818cf8"></i>
      </div>
      <h1 style="font-size:24px;font-weight:900;margin-bottom:6px">Check your email & phone</h1>
      <p id="sub" style="color:#6b7280;font-size:14px">We sent a 6-digit code to your email and SMS</p>
    </div>
    <div class="card">
      <div class="step-bar"><div class="step-dot done"></div><div class="step-dot active"></div><div class="step-dot"></div></div>
      <p style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:24px">Step 2 of 3 — Enter Verification Code</p>
      <div class="err" id="err"></div>
      <div class="code-inputs">
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c0"/>
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c1"/>
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c2"/>
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c3"/>
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c4"/>
        <input type="text" inputmode="numeric" maxlength="1" class="ci" id="c5"/>
      </div>
      <p style="text-align:center;font-size:12px;color:#6b7280;margin-bottom:20px">Enter the 6-digit code</p>
      <button class="btn-primary" id="btn" onclick="submitCode()">
        <i class="fas fa-check"></i> Verify Code
      </button>
      <p style="text-align:center;font-size:13px;color:#6b7280;margin-top:16px">
        Didn't receive it? <a href="/free-trial" style="color:#818cf8">Go back and resend</a>
      </p>
    </div>
  </div>
</div>
<script>
const email = sessionStorage.getItem('trial_email') || ''
const company = sessionStorage.getItem('trial_company') || ''
if (!email) { window.location.href = '/free-trial' }
document.getElementById('sub').textContent = 'We sent a 6-digit code to ' + email

// Auto-advance between boxes
document.querySelectorAll('.ci').forEach((inp, i, all) => {
  inp.addEventListener('input', function() {
    this.value = this.value.replace(/[^0-9]/g,'').slice(-1)
    if (this.value && i < 5) all[i+1].focus()
    if (i === 5 && this.value) submitCode()
  })
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Backspace' && !this.value && i > 0) all[i-1].focus()
  })
  inp.addEventListener('paste', function(e) {
    const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\\D/g,'').slice(0,6)
    if (paste.length === 6) {
      paste.split('').forEach((ch, idx) => { if(all[idx]) { all[idx].value = ch } })
      all[5].focus()
      setTimeout(submitCode, 100)
    }
    e.preventDefault()
  })
})
document.getElementById('c0').focus()

async function submitCode() {
  const code = Array.from(document.querySelectorAll('.ci')).map(i => i.value).join('')
  if (code.length < 6) { return }
  const err = document.getElementById('err')
  const btn = document.getElementById('btn')
  err.style.display = 'none'
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Verifying...'
  try {
    const r = await fetch('/api/free-trial/verify-code', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, code })
    })
    const d = await r.json()
    if (d.success) {
      sessionStorage.setItem('trial_token', d.token)
      window.location.href = '/free-trial/setup'
    } else {
      err.textContent = d.error || 'Incorrect code'
      err.style.display = 'block'
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-check"></i> Verify Code'
    }
  } catch(ex) {
    err.textContent = 'Connection error'
    err.style.display = 'block'
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-check"></i> Verify Code'
  }
}
</script></body></html>`
}

function getFreeTrialStep3HTML(): string {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Set Up Your Account — ClockInProof</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#030712;color:#f9fafb;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
    .card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:32px}
    .inp{width:100%;padding:14px 16px;background:#1f2937;border:1px solid #374151;border-radius:12px;color:#f9fafb;font-size:15px;outline:none;transition:border .15s}
    .inp:focus{border-color:#4f46e5}
    .btn-primary{width:100%;padding:15px;background:#4f46e5;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:8px}
    .btn-primary:hover:not(:disabled){background:#4338ca}
    .btn-primary:disabled{opacity:.6;cursor:not-allowed}
    .err{display:none;background:#450a0a;border:1px solid #dc2626;border-radius:10px;padding:12px 16px;font-size:14px;color:#fca5a5;margin-bottom:16px}
    .logo{display:inline-block;background:#4F46E5;color:#fff;font-weight:900;font-size:17px;padding:9px 18px;border-radius:10px;text-decoration:none}
    .logo span{color:#a5b4fc}
    .step-bar{display:flex;gap:6px;margin-bottom:28px}
    .step-dot{flex:1;height:4px;border-radius:2px;background:#1f2937}
    .step-dot.done{background:#4f46e5}
    .step-dot.active{background:#818cf8}
    label{display:block;font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
    select.inp option{background:#1f2937}
  </style>

</head><body>
<nav style="padding:16px 24px;border-bottom:1px solid #1f2937;display:flex;align-items:center">
  <a href="/" class="logo">ClockIn<span>Proof</span></a>
  <span style="margin-left:12px;font-size:13px;color:#4ade80"><i class="fas fa-check-circle"></i> Identity verified</span>
</nav>
<div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 65px);padding:24px">
  <div style="width:100%;max-width:520px">

    <!-- Success state -->
    <div id="success" style="display:none;text-align:center;padding:40px 0">
      <div style="width:80px;height:80px;background:#052e16;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;border:2px solid #166534">
        <i class="fas fa-rocket" style="font-size:32px;color:#4ade80"></i>
      </div>
      <h2 style="font-size:24px;font-weight:900;margin-bottom:8px">You're all set!</h2>
      <p style="color:#6b7280;margin-bottom:28px">Check your email for login details. Your 60-day trial starts now.</p>
      <a id="admin-link" href="https://admin.clockinproof.com" style="display:inline-flex;align-items:center;gap:8px;background:#4f46e5;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;margin-bottom:12px">
        <i class="fas fa-tachometer-alt"></i> Open Admin Dashboard
      </a>
      <br/>
      <a id="worker-link" href="#" style="display:inline-flex;align-items:center;gap:8px;color:#818cf8;padding:10px;text-decoration:none;font-size:14px;margin-top:8px">
        <i class="fas fa-mobile-alt"></i> Worker App: <span id="worker-url"></span>
      </a>
    </div>

    <!-- Form -->
    <div id="form-wrap">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="font-size:24px;font-weight:900;margin-bottom:6px">Set up your account</h1>
        <p style="color:#6b7280;font-size:14px">Almost done — fill in your company details</p>
      </div>
      <div class="card">
        <div class="step-bar"><div class="step-dot done"></div><div class="step-dot done"></div><div class="step-dot active"></div></div>
        <p style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:20px">Step 3 of 3 — Account Setup</p>
        <div class="err" id="err"></div>
        <form id="form" style="display:flex;flex-direction:column;gap:14px">

          <div>
            <label>Company Name *</label>
            <input id="t-company" class="inp" type="text" required/>
          </div>

          <div>
            <label>Your Subdomain *</label>
            <div style="display:flex">
              <input id="t-slug" class="inp" type="text" required maxlength="40" placeholder="mycompany"
                style="border-radius:12px 0 0 12px;border-right:none" oninput="checkSlug()"/>
              <span style="padding:14px 12px;background:#374151;border:1px solid #374151;border-radius:0 12px 12px 0;font-size:12px;color:#9ca3af;white-space:nowrap;display:flex;align-items:center">.clockinproof.com</span>
            </div>
            <p id="slug-msg" style="font-size:12px;margin-top:4px;min-height:1em;color:#6b7280"></p>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label>Admin Email *</label>
              <input id="t-email" class="inp" type="email" required readonly style="opacity:.7"/>
            </div>
            <div>
              <label>Admin PIN * (4–8 digits)</label>
              <input id="t-pin" class="inp" type="text" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="e.g. 5821" required/>
            </div>
          </div>

          <div>
            <label>Mobile Phone *</label>
            <input id="t-phone" class="inp" type="tel" required/>
          </div>

          <div>
            <label>Company Address *</label>
            <div style="display:flex;flex-direction:column;gap:8px">
              <input id="t-street" class="inp" type="text" placeholder="Street number &amp; name" required/>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <input id="t-city" class="inp" type="text" placeholder="City" required/>
                <input id="t-provstate" class="inp" type="text" placeholder="Province / State" required maxlength="3"/>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <select id="t-country" class="inp">
                  <option value="CA">Canada</option>
                  <option value="US">United States</option>
                </select>
                <input id="t-postal" class="inp" type="text" placeholder="Postal / ZIP" required maxlength="10"/>
              </div>
            </div>
          </div>

          <button type="submit" class="btn-primary" id="btn">
            <i class="fas fa-rocket"></i> Create My Account
          </button>
          <p style="text-align:center;font-size:12px;color:#374151"><i class="fas fa-lock" style="margin-right:4px"></i>No credit card · No commitment · Cancel anytime</p>
        </form>
      </div>
    </div>
  </div>
</div>
<script>
const token = sessionStorage.getItem('trial_token')
const email = sessionStorage.getItem('trial_email') || ''
const company = sessionStorage.getItem('trial_company') || ''
const phone = sessionStorage.getItem('trial_phone') || ''
if (!token || !email) { window.location.href = '/free-trial' }

// Pre-fill known values
document.getElementById('t-email').value = email
document.getElementById('t-company').value = company
document.getElementById('t-phone').value = phone

// Auto-generate slug from company
const compInp = document.getElementById('t-company')
compInp.addEventListener('input', function() {
  document.getElementById('t-slug').value = this.value.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').substring(0,30)
  checkSlug()
})
if (company) { compInp.dispatchEvent(new Event('input')) }

let _slugTimer
function checkSlug() {
  clearTimeout(_slugTimer)
  const slug = document.getElementById('t-slug').value.trim()
  const msg = document.getElementById('slug-msg')
  if (!slug) { msg.textContent = ''; return }
  msg.innerHTML = '<span style="color:#6b7280"><i class="fas fa-circle-notch fa-spin" style="margin-right:4px"></i>Checking...</span>'
  _slugTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/slug-check?slug=' + encodeURIComponent(slug))
      const d = await r.json()
      msg.innerHTML = d.available
        ? '<span style="color:#4ade80"><i class="fas fa-check" style="margin-right:4px"></i>' + slug + '.clockinproof.com is available</span>'
        : '<span style="color:#f87171"><i class="fas fa-times" style="margin-right:4px"></i>Already taken — try another</span>'
    } catch { msg.textContent = '' }
  }, 500)
}

document.getElementById('form').addEventListener('submit', async function(e) {
  e.preventDefault()
  const err = document.getElementById('err')
  const btn = document.getElementById('btn')
  err.style.display = 'none'
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Creating your account...'
  const address = [
    document.getElementById('t-street').value.trim(),
    document.getElementById('t-city').value.trim(),
    document.getElementById('t-provstate').value.trim(),
    document.getElementById('t-country').value,
    document.getElementById('t-postal').value.trim()
  ].filter(Boolean).join(', ')
  try {
    const r = await fetch('/api/free-trial', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        company_name: document.getElementById('t-company').value.trim(),
        slug: document.getElementById('t-slug').value.trim(),
        admin_email: document.getElementById('t-email').value.trim(),
        admin_pin: document.getElementById('t-pin').value.trim(),
        phone: document.getElementById('t-phone').value.trim(),
        company_address: address,
        verify_token: token
      })
    })
    const d = await r.json()
    if (d.success) {
      sessionStorage.clear()
      document.getElementById('form-wrap').style.display = 'none'
      const succ = document.getElementById('success')
      succ.style.display = 'block'
      document.getElementById('admin-link').href = d.admin_url
      document.getElementById('worker-link').href = d.worker_url
      document.getElementById('worker-url').textContent = d.slug + '.clockinproof.com'
    } else {
      err.textContent = d.error || 'Something went wrong'
      err.style.display = 'block'
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-rocket"></i> Create My Account'
    }
  } catch(ex) {
    err.textContent = 'Connection error — please try again'
    err.style.display = 'block'
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-rocket"></i> Create My Account'
  }
})
</script></body></html>`
}


// ─── HTML Templates ───────────────────────────────────────────────────────────

// ─── SIGNUP PAGE ──────────────────────────────────────────────────────────────
function getSignupHTML(plan: string): string {
  // plan name passed as URL param — page loads plan details dynamically from /api/plans
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Start Your Free Trial — ClockInProof</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center px-4 py-12">
  <div class="w-full max-w-lg">
    <!-- Logo -->
    <div class="text-center mb-8">
      <a href="/" class="inline-flex items-center gap-2 text-white font-black text-xl">
        <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-sm font-black">C</div>
        ClockInProof
      </a>
    </div>

    <!-- Selected Plan Badge (populated by JS) -->
    <div class="bg-blue-600/20 border border-blue-500/30 rounded-2xl p-4 mb-6 flex items-center justify-between" id="plan-badge">
      <div>
        <p class="font-bold text-blue-300" id="plan-badge-name">Loading plan…</p>
        <p class="text-sm text-gray-400" id="plan-badge-workers"></p>
        <ul class="mt-2 space-y-1" id="plan-badge-features"></ul>
      </div>
      <div class="text-right ml-4 flex-shrink-0">
        <p class="text-2xl font-black text-white" id="plan-badge-price"></p>
        <p class="text-xs text-gray-500">14-day free trial</p>
        <a href="/landing#pricing" class="text-xs text-blue-400 hover:underline mt-1 block">Change plan</a>
      </div>
    </div>

    <!-- Signup Form -->
    <div class="bg-gray-900 border border-white/10 rounded-2xl p-8">
      <h1 class="text-2xl font-black mb-2">Create your account</h1>
      <p class="text-gray-400 text-sm mb-6">Your subdomain will be ready in seconds.</p>

      <div id="signup-error" class="hidden bg-red-900/50 border border-red-500/50 text-red-300 rounded-xl p-3 text-sm mb-4"></div>
      <div id="signup-success" class="hidden bg-green-900/50 border border-green-500/50 text-green-300 rounded-xl p-4 text-sm mb-4"></div>

      <form id="signup-form" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm text-gray-400 mb-1">Company Name *</label>
            <input id="f-company" type="text" placeholder="Acme Cleaning Co." required
              class="w-full px-4 py-3 bg-gray-800 border border-white/10 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          </div>
          <div>
            <label class="block text-sm text-gray-400 mb-1">Your Subdomain *</label>
            <div class="relative">
              <input id="f-slug" type="text" placeholder="acme" required
                class="w-full px-4 py-3 bg-gray-800 border border-white/10 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 pr-32"/>
              <span class="absolute right-3 top-3 text-xs text-gray-500">.clockinproof.com</span>
            </div>
            <p id="slug-status" class="text-xs mt-1 text-gray-500"></p>
          </div>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Admin Email *</label>
          <input id="f-email" type="email" placeholder="you@company.com" required
            class="w-full px-4 py-3 bg-gray-800 border border-white/10 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Admin PIN (4–6 digits) *</label>
          <input id="f-pin" type="number" placeholder="1234" required minlength="4" maxlength="6"
            class="w-full px-4 py-3 bg-gray-800 border border-white/10 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
          <p class="text-xs text-gray-600 mt-1">Used to log into your admin panel</p>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Company Address</label>
          <input id="f-address" type="text" placeholder="123 Main St, Ottawa, ON"
            class="w-full px-4 py-3 bg-gray-800 border border-white/10 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/>
        </div>

        <button type="submit" id="signup-btn"
          class="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl transition text-base flex items-center justify-center gap-2">
          <i class="fas fa-rocket"></i>
          <span id="signup-btn-text">Start 14-Day Free Trial</span>
        </button>
        <p class="text-center text-xs text-gray-500 mt-2">
          <i class="fas fa-lock mr-1"></i>Secured by Stripe · Cancel anytime · No setup fees
        </p>
      </form>

      <p class="text-center text-xs text-gray-600 mt-4">
        By signing up you agree to our
        <a href="/terms" class="text-blue-500 underline">Terms of Service</a> and
        <a href="/privacy" class="text-blue-500 underline">Privacy Policy</a>.
        <br>Card required to start — 14-day free trial, not charged until trial ends.
      </p>
    </div>

    <p class="text-center text-gray-600 text-sm mt-6">
      Already have an account? <a href="/admin" class="text-blue-400 underline">Sign in</a>
    </p>
  </div>

<script>
// ── Dynamic plan loader ───────────────────────────────────────────────────────
const PLAN = '${plan}'
let PRICE_ID = ''
let planPriceDisplay = 'Free Trial'

;(async function loadPlanDetails() {
  try {
    const res = await fetch('/api/plans')
    const data = await res.json()
    const plans = data.plans || []
    // Match by slug (lowercase name)
    const p = plans.find(x => (x.name||'').toLowerCase() === PLAN) || plans[0]
    if (!p) return

    PRICE_ID = p.stripe_price_id || ''
    const dollars = Math.floor(p.price_monthly / 100)
    const cents   = p.price_monthly % 100
    planPriceDisplay = '$' + dollars + (cents ? '.' + String(cents).padStart(2,'0') : '') + ' CAD/mo'
    const workers = p.max_workers >= 999 ? 'Unlimited workers' : 'Up to ' + p.max_workers + ' workers'
    const features = (p.features || '').split(',').filter(Boolean)

    document.getElementById('plan-badge-name').textContent    = p.name + ' Plan'
    document.getElementById('plan-badge-workers').textContent = workers
    document.getElementById('plan-badge-price').textContent   = planPriceDisplay
    document.getElementById('plan-badge-features').innerHTML  =
      features.map(f => '<li class="text-xs text-gray-400"><span class="text-green-400 mr-1">✓</span>' + f.trim() + '</li>').join('')
    document.getElementById('signup-btn-text').textContent    = 'Start 14-Day Free Trial — ' + planPriceDisplay
  } catch(e) {
    document.getElementById('plan-badge-name').textContent = PLAN.charAt(0).toUpperCase() + PLAN.slice(1) + ' Plan'
  }
})()

// ── Slug checker ──────────────────────────────────────────────────────────────
document.getElementById('f-company').addEventListener('input', function() {
  const slug = this.value.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 30)
  document.getElementById('f-slug').value = slug
  checkSlug(slug)
})

document.getElementById('f-slug').addEventListener('input', function() {
  checkSlug(this.value)
})

let slugTimer = null
function checkSlug(slug) {
  const el = document.getElementById('slug-status')
  if (!slug || slug.length < 2) { el.textContent = ''; return }
  el.textContent = 'Checking\u2026'
  el.className = 'text-xs mt-1 text-gray-500'
  clearTimeout(slugTimer)
  slugTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/tenants/check-slug?slug=' + encodeURIComponent(slug))
      const data = await res.json()
      if (data.available) {
        el.textContent = '\u2705 ' + slug + '.clockinproof.com is available!'
        el.className = 'text-xs mt-1 text-green-400'
      } else {
        el.textContent = '\u274C That subdomain is taken'
        el.className = 'text-xs mt-1 text-red-400'
      }
    } catch { el.textContent = '' }
  }, 500)
}

// ── Form submission ───────────────────────────────────────────────────────────
document.getElementById('signup-form').addEventListener('submit', async function(e) {
  e.preventDefault()
  const btn    = document.getElementById('signup-btn')
  const btnTxt = document.getElementById('signup-btn-text')
  const errEl  = document.getElementById('signup-error')
  btn.disabled = true
  btnTxt.textContent = 'Setting up your account\u2026'
  errEl.classList.add('hidden')

  const slug        = document.getElementById('f-slug').value.trim()
  const companyName = document.getElementById('f-company').value.trim()
  const email       = document.getElementById('f-email').value.trim()
  const pin         = document.getElementById('f-pin').value.trim()
  const address     = document.getElementById('f-address').value.trim()

  try {
    // Step 1: Pre-register tenant
    const regRes = await fetch('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, company_name: companyName, company_address: address, admin_email: email, admin_pin: pin, plan: PLAN })
    })
    const regData = await regRes.json()
    if (!regRes.ok) {
      errEl.textContent = regData.error || 'Signup failed. Please try again.'
      errEl.classList.remove('hidden')
      btn.disabled = false
      btnTxt.textContent = 'Start 14-Day Free Trial \u2014 ' + planPriceDisplay
      return
    }

    // Step 2: Create Stripe Checkout session \u2192 redirect
    const checkoutRes = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: regData.id, price_id: PRICE_ID, email, company_name: companyName, slug, plan: PLAN,
        success_url: window.location.origin + '/welcome?tenant=' + slug,
        cancel_url: window.location.origin + '/signup?plan=' + PLAN
      })
    })
    const checkoutData = await checkoutRes.json()
    if (checkoutRes.ok && checkoutData.url) {
      window.location.href = checkoutData.url
    } else {
      errEl.textContent = checkoutData.error || 'Could not start checkout. Please try again.'
      errEl.classList.remove('hidden')
      btn.disabled = false
      btnTxt.textContent = 'Start 14-Day Free Trial \u2014 ' + planPriceDisplay
    }
  } catch(e) {
    errEl.textContent = 'Network error. Please try again.'
    errEl.classList.remove('hidden')
    btn.disabled = false
    btnTxt.textContent = 'Start 14-Day Free Trial \u2014 ' + planPriceDisplay
  }
})
</script>
</body>
</html>`
}

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
function getLandingHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>ClockInProof — Stop Time Piracy. GPS-Verified Time Tracking.</title>
  <meta name="description" content="Workers faking clock-ins costs you thousands a year. ClockInProof uses GPS geofencing to prove every worker was actually on site — no hardware, no app downloads."/>
  <meta property="og:title" content="ClockInProof — Stop Time Piracy"/>
  <meta property="og:description" content="GPS-verified clock-ins for trades, restoration, HVAC, construction & field teams. Catch fraud before it happens."/>
  <meta property="og:image" content="/static/icon-512.png"/>
  <link rel="icon" href="/static/icon-180.png"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #0a0f1e 0%, #0f2040 40%, #0a0f1e 100%); }
    .gradient-card { background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%); }
    .gradient-red { background: linear-gradient(135deg, #7f1d1d 0%, #dc2626 100%); }
    .glow-blue { box-shadow: 0 0 40px rgba(59,130,246,0.35); }
    .glow-red  { box-shadow: 0 0 40px rgba(220,38,38,0.35); }
    .feature-card { transition: transform 0.3s ease, box-shadow 0.3s ease; }
    .feature-card:hover { transform: translateY(-5px); box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    .pricing-popular { border: 2px solid #3b82f6; position: relative; }
    .pricing-popular::before { content: 'MOST POPULAR'; position: absolute; top: -13px; left: 50%; transform: translateX(-50%); background: #3b82f6; color: white; font-size: 10px; font-weight: 800; padding: 3px 14px; border-radius: 20px; letter-spacing: 1.5px; white-space:nowrap; }
    .nav-blur { backdrop-filter: blur(14px); background: rgba(10,15,30,0.88); }
    html { scroll-behavior: smooth; }
    .pirate-strike { position:relative; display:inline-block; }
    .pirate-strike::after { content:''; position:absolute; left:0; right:0; top:50%; height:3px; background:#ef4444; transform:rotate(-4deg); border-radius:2px; }
    .stat-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
    .industry-pill { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); transition: all 0.2s; }
    .industry-pill:hover { background: rgba(59,130,246,0.15); border-color: rgba(59,130,246,0.4); }
    @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
    .float { animation: float 3s ease-in-out infinite; }
    @keyframes pulse-ring { 0%{transform:scale(1);opacity:0.6} 100%{transform:scale(1.8);opacity:0} }
    .pulse-ring::before { content:''; position:absolute; inset:-6px; border-radius:50%; border:2px solid #22c55e; animation: pulse-ring 1.5s ease-out infinite; }
  </style>
</head>
<body class="bg-gray-950 text-white">

<!-- ── NAV ──────────────────────────────────────────────────────────────────── -->
<nav class="fixed top-0 left-0 right-0 z-50 nav-blur border-b border-white/10">
  <div class="max-w-6xl mx-auto px-5 py-3.5 flex items-center justify-between">
    <div class="flex items-center gap-2.5">
      <img src="/static/icon-180.png" class="w-8 h-8 rounded-lg" alt="ClockInProof" onerror="this.style.display='none'"/>
      <span class="font-black text-lg tracking-tight">ClockIn<span class="text-blue-400">Proof</span></span>
    </div>
    <div class="hidden md:flex items-center gap-7 text-sm text-gray-300">
      <a href="#problem" class="hover:text-white transition">The Problem</a>
      <a href="#features" class="hover:text-white transition">Features</a>
      <a href="#how-it-works" class="hover:text-white transition">How It Works</a>
      <a href="#pricing" class="hover:text-white transition">Pricing</a>
      <a href="#faq" class="hover:text-white transition">FAQ</a>
    </div>
    <div class="flex items-center gap-2">
      <a href="https://admin.clockinproof.com" class="text-sm text-gray-400 hover:text-white transition px-3 py-2 rounded-lg border border-white/20 hover:border-white/40 hover:bg-white/10">
        <i class="fas fa-sign-in-alt mr-1.5"></i>Sign In
      </a>
      <a href="#pricing" class="hidden sm:inline-flex bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-4 py-2 rounded-lg transition glow-blue">
        Start Free Trial
      </a>
    </div>
  </div>
</nav>

<!-- ── HERO ──────────────────────────────────────────────────────────────────── -->
<section class="gradient-hero min-h-screen flex items-center pt-20 relative overflow-hidden">
  <!-- Background grid -->
  <div class="absolute inset-0 opacity-5" style="background-image:linear-gradient(rgba(99,102,241,0.5) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.5) 1px,transparent 1px);background-size:60px 60px"></div>

  <div class="max-w-6xl mx-auto px-5 py-24 relative z-10">
    <div class="grid lg:grid-cols-2 gap-16 items-center">

      <!-- Left copy -->
      <div>
        <div class="inline-flex items-center gap-2 bg-red-600/20 border border-red-500/30 rounded-full px-4 py-1.5 text-red-300 text-xs font-bold mb-6 uppercase tracking-wider">
          <i class="fas fa-exclamation-triangle"></i>
          Time Theft Is Costing You Thousands
        </div>
        <h1 class="text-5xl md:text-6xl font-black mb-5 leading-[1.05]">
          Stop <span class="pirate-strike text-gray-400">Time</span><br/>
          <span class="text-blue-400">Piracy.</span>
        </h1>
        <p class="text-xl text-gray-300 mb-4 leading-relaxed">
          Your workers are clocking in from home, the truck, or the Tim Hortons down the street — and you're paying for every minute.
        </p>
        <p class="text-lg text-gray-400 mb-8 leading-relaxed">
          ClockInProof GPS-locks every clock-in to the job site. <strong class="text-white">No GPS match = no clock-in.</strong> Simple as that.
        </p>

        <!-- Stats row -->
        <div class="grid grid-cols-3 gap-3 mb-10">
          <div class="stat-card rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-red-400">4.5 hrs</div>
            <div class="text-xs text-gray-500 mt-1">avg. time theft/week per employee*</div>
          </div>
          <div class="stat-card rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-yellow-400">$5,200</div>
            <div class="text-xs text-gray-500 mt-1">annual cost per dishonest worker*</div>
          </div>
          <div class="stat-card rounded-xl p-4 text-center">
            <div class="text-2xl font-black text-green-400">5 min</div>
            <div class="text-xs text-gray-500 mt-1">to set up ClockInProof</div>
          </div>
        </div>

        <div class="flex flex-col sm:flex-row gap-3">
          <a href="#pricing" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-8 py-4 rounded-xl text-base transition glow-blue text-center">
            <i class="fas fa-shield-alt mr-2"></i>Start Free — 14 Days
          </a>
          <a href="#how-it-works" class="border border-white/20 hover:border-blue-400/50 text-white font-semibold px-8 py-4 rounded-xl text-base transition text-center">
            <i class="fas fa-play mr-2 text-blue-400"></i>See How It Works
          </a>
        </div>
        <p class="text-gray-600 text-xs mt-4">No credit card · No app download · Works on any phone</p>
      </div>

      <!-- Right: phone mockup -->
      <div class="flex justify-center">
        <div class="relative float">
          <!-- Phone frame -->
          <div class="bg-gray-900 rounded-3xl border border-white/10 p-5 w-72 glow-blue">
            <!-- Status bar mock -->
            <div class="flex justify-between items-center mb-5 px-1">
              <span class="text-xs text-gray-500">9:41 AM</span>
              <div class="flex gap-1 text-gray-500 text-xs"><i class="fas fa-signal"></i><i class="fas fa-wifi"></i><i class="fas fa-battery-three-quarters"></i></div>
            </div>
            <!-- Worker card -->
            <div class="mb-4">
              <div class="flex items-center justify-between mb-3">
                <div>
                  <p class="text-xs text-gray-500">Good morning</p>
                  <p class="font-bold">Marcus Johnson</p>
                </div>
                <div class="relative">
                  <div class="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center pulse-ring">
                    <span class="font-bold text-sm">MJ</span>
                  </div>
                </div>
              </div>
              <!-- Clock-in status -->
              <div class="bg-green-500/10 border border-green-500/30 rounded-2xl p-4 mb-3">
                <div class="flex items-center gap-2 mb-2">
                  <div class="w-2.5 h-2.5 rounded-full bg-green-400" style="animation:pulse 1.5s infinite"></div>
                  <span class="text-green-400 text-xs font-bold tracking-wide">CLOCKED IN — 7:52 AM</span>
                </div>
                <p class="text-xs text-gray-300 mb-1"><i class="fas fa-map-marker-alt text-blue-400 mr-1.5 w-3"></i>2310 Easy St, Ottawa ON</p>
                <p class="text-xs text-gray-300 mb-1"><i class="fas fa-shield-alt text-green-400 mr-1.5 w-3"></i>GPS verified · 22m from site ✓</p>
                <p class="text-xs text-gray-400"><i class="fas fa-hard-hat text-yellow-400 mr-1.5 w-3"></i>Water damage restoration</p>
              </div>
              <!-- Timer -->
              <div class="text-center py-2">
                <div class="text-4xl font-black text-white">6:24:11</div>
                <p class="text-xs text-gray-500 mt-1">Time on site today</p>
                <p class="text-sm text-green-400 font-semibold mt-1">$144.06 earned</p>
              </div>
            </div>
            <!-- Clock out button -->
            <button class="w-full bg-red-600/20 border border-red-500/30 text-red-400 font-bold py-3 rounded-xl text-sm">
              <i class="fas fa-stop-circle mr-2"></i>Clock Out
            </button>
          </div>
          <!-- Admin notification badge -->
          <div class="absolute -top-3 -right-4 bg-blue-600 rounded-xl px-3 py-2 text-xs font-bold shadow-lg glow-blue">
            <i class="fas fa-eye mr-1"></i>Admin sees this live
          </div>
          <!-- Blocked attempt badge -->
          <div class="absolute -bottom-3 -left-4 bg-red-600 rounded-xl px-3 py-2 text-xs font-bold shadow-lg glow-red">
            <i class="fas fa-ban mr-1"></i>Remote login blocked
          </div>
        </div>
      </div>

    </div>
  </div>
</section>

<!-- ── INDUSTRIES ─────────────────────────────────────────────────────────────── -->
<section class="bg-gray-900 border-y border-white/5 py-10">
  <div class="max-w-5xl mx-auto px-5">
    <p class="text-center text-gray-500 text-xs font-bold uppercase tracking-widest mb-6">Built for every field service industry</p>
    <div class="flex flex-wrap justify-center gap-3">
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-fire-extinguisher mr-2 text-red-400"></i>Restoration</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-hard-hat mr-2 text-yellow-400"></i>Construction</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-bolt mr-2 text-yellow-300"></i>Electrical</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-wrench mr-2 text-blue-400"></i>Plumbing</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-snowflake mr-2 text-cyan-400"></i>HVAC</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-spray-can mr-2 text-purple-400"></i>Painting</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-tint mr-2 text-blue-300"></i>Fire Suppression</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-leaf mr-2 text-green-400"></i>Landscaping</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-broom mr-2 text-indigo-400"></i>Cleaning</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-shield-alt mr-2 text-gray-400"></i>Security</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-tools mr-2 text-orange-400"></i>General Trades</span>
      <span class="industry-pill rounded-full px-4 py-2 text-sm text-gray-300"><i class="fas fa-truck mr-2 text-red-300"></i>Delivery & Logistics</span>
    </div>
  </div>
</section>

<!-- ── THE PROBLEM ───────────────────────────────────────────────────────────── -->
<section id="problem" class="py-24 bg-gray-950">
  <div class="max-w-5xl mx-auto px-5">
    <div class="text-center mb-14">
      <div class="inline-flex items-center gap-2 bg-red-600/10 border border-red-500/20 rounded-full px-4 py-1.5 text-red-400 text-xs font-bold uppercase tracking-wider mb-4">
        <i class="fas fa-skull-crossbones"></i> The Time Piracy Problem
      </div>
      <h2 class="text-4xl font-black mb-4">How workers steal time<br/><span class="text-red-400">without you knowing</span></h2>
      <p class="text-gray-400 text-lg max-w-2xl mx-auto">Field service businesses lose 2–8% of payroll to time theft every year. Here's how it happens:</p>
    </div>
    <div class="grid md:grid-cols-3 gap-6">
      <div class="bg-red-950/30 border border-red-900/40 rounded-2xl p-6">
        <div class="w-12 h-12 bg-red-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-home text-red-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2 text-red-300">Clocking in from home</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Worker opens the app at home, logs 8 hours, shows up at 10am. You pay for 3 hours they weren't there. Happens every week.</p>
      </div>
      <div class="bg-red-950/30 border border-red-900/40 rounded-2xl p-6">
        <div class="w-12 h-12 bg-red-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-users text-red-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2 text-red-300">Buddy punching</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Worker A is running late, calls Worker B to clock them in. Classic. Costs the average trades company $850/month.</p>
      </div>
      <div class="bg-red-950/30 border border-red-900/40 rounded-2xl p-6">
        <div class="w-12 h-12 bg-red-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-ghost text-red-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2 text-red-300">Ghost hours</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Worker clocks out 2 hours after they actually left. You're still paying. No paper trail, no way to dispute it. Until now.</p>
      </div>
    </div>
    <div class="mt-10 bg-blue-950/30 border border-blue-800/30 rounded-2xl p-6 text-center">
      <p class="text-blue-300 font-semibold text-lg"><i class="fas fa-shield-alt mr-2 text-blue-400"></i>ClockInProof makes all three impossible. GPS location is required to clock in — and we verify it's real.</p>
    </div>
  </div>
</section>

<!-- ── FEATURES ──────────────────────────────────────────────────────────────── -->
<section id="features" class="py-24 bg-gray-900">
  <div class="max-w-6xl mx-auto px-5">
    <div class="text-center mb-14">
      <h2 class="text-4xl font-black mb-4">Every feature you need.<br/><span class="text-blue-400">All included. Every plan.</span></h2>
      <p class="text-gray-400 text-lg max-w-xl mx-auto">No feature tiers. No upsells. Every plan gets the full platform.</p>
    </div>
    <div class="grid md:grid-cols-3 gap-5">

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-blue-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-map-pin text-blue-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">GPS Clock-In Proof</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Every clock-in is GPS-stamped and mapped. You see exactly where your worker stood when they clocked in — timestamped forever.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-green-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-draw-polygon text-green-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Geofence Enforcement</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Set a radius around each job site. Workers outside the zone are blocked — or you get an instant alert to approve or deny.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-yellow-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-paper-plane text-yellow-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Job Dispatch by SMS</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Send a worker to a job with one tap. They get an SMS with the address, Google Maps link, and job details. Clock-in modal auto-fills when they arrive.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-purple-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-robot text-purple-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Auto Clock-Out</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Worker leaves the geofence for 30+ minutes? System clocks them out automatically. No overpay, no chasing workers for forgotten clock-outs.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-cyan-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-satellite-dish text-cyan-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Live GPS Map</h3>
        <p class="text-gray-400 text-sm leading-relaxed">See all active workers on a live map right now. Know who's on site, who's drifted, and who's AWOL — updated every 5 minutes.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-orange-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-bell text-orange-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Instant SMS + Email Alerts</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Get notified the second a worker tries to clock in from outside the zone. Approve or deny from your phone in one tap.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-emerald-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-file-invoice-dollar text-emerald-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">Automated Payroll Reports</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Weekly payroll with hours, earnings, stat holiday pay, and per-worker summaries. Export CSV or email directly to your accountant.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-indigo-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-link text-indigo-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">QuickBooks Integration</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Sync hours directly into QuickBooks Online. Map workers to QB employees and push time data with one click — no manual entry.</p>
      </div>

      <div class="feature-card bg-gray-950 border border-white/5 rounded-2xl p-6">
        <div class="w-12 h-12 bg-pink-600/20 rounded-xl flex items-center justify-center mb-4">
          <i class="fas fa-mobile-alt text-pink-400 text-xl"></i>
        </div>
        <h3 class="font-bold text-lg mb-2">No App Download Required</h3>
        <p class="text-gray-400 text-sm leading-relaxed">Workers get a link by SMS. Open in any browser, enter PIN — done. No App Store, no Google Play, no IT support needed.</p>
      </div>

    </div>
  </div>
</section>

<!-- ── HOW IT WORKS ───────────────────────────────────────────────────────────── -->
<section id="how-it-works" class="py-24 bg-gray-950">
  <div class="max-w-4xl mx-auto px-5">
    <div class="text-center mb-14">
      <h2 class="text-4xl font-black mb-4">Up and running<br/><span class="text-blue-400">in under 5 minutes</span></h2>
      <p class="text-gray-400 text-lg">No IT. No training. No hardware. Works on the phone your workers already have.</p>
    </div>
    <div class="space-y-6">

      <div class="flex gap-5 items-start bg-gray-900 rounded-2xl p-6 border border-white/5">
        <div class="w-12 h-12 gradient-card rounded-xl flex items-center justify-center flex-shrink-0 font-black text-xl">1</div>
        <div>
          <h3 class="font-bold text-xl mb-1.5">Create your account → Add your job sites</h3>
          <p class="text-gray-400 leading-relaxed text-sm">Enter your business name and job site addresses. Set geofence radius per site (100m to 1km). Takes 3 minutes.</p>
        </div>
      </div>

      <div class="flex gap-5 items-start bg-gray-900 rounded-2xl p-6 border border-white/5">
        <div class="w-12 h-12 gradient-card rounded-xl flex items-center justify-center flex-shrink-0 font-black text-xl">2</div>
        <div>
          <h3 class="font-bold text-xl mb-1.5">Add workers → Send them the link</h3>
          <p class="text-gray-400 leading-relaxed text-sm">Enter each worker's name and phone number. Tap "Send Invite" — they get an SMS with a one-tap link. They set a PIN. That's their login. Forever.</p>
        </div>
      </div>

      <div class="flex gap-5 items-start bg-gray-900 rounded-2xl p-6 border border-white/5">
        <div class="w-12 h-12 gradient-card rounded-xl flex items-center justify-center flex-shrink-0 font-black text-xl">3</div>
        <div>
          <h3 class="font-bold text-xl mb-1.5">Workers clock in — GPS verified in real-time</h3>
          <p class="text-gray-400 leading-relaxed text-sm">Worker taps Clock In on their phone. GPS is captured instantly. If they're at the site — approved. If they're not — blocked and you're notified.</p>
        </div>
      </div>

      <div class="flex gap-5 items-start bg-gray-900 rounded-2xl p-6 border border-white/5">
        <div class="w-12 h-12 gradient-card rounded-xl flex items-center justify-center flex-shrink-0 font-black text-xl">4</div>
        <div>
          <h3 class="font-bold text-xl mb-1.5">Payroll calculates itself — export when ready</h3>
          <p class="text-gray-400 leading-relaxed text-sm">Every shift is tracked and calculated — hours, earnings, stat holiday pay. Export weekly payroll or push straight to QuickBooks. Your accountant will love it.</p>
        </div>
      </div>

    </div>
  </div>
</section>

<!-- ── PRICING ────────────────────────────────────────────────────────────────── -->
<section id="pricing" class="py-24 bg-gray-900">
  <div class="max-w-5xl mx-auto px-5">
    <div class="text-center mb-14">
      <h2 class="text-4xl font-black mb-3">Simple pricing.<br/><span class="text-blue-400">All features. Every plan.</span></h2>
      <p class="text-gray-400 text-lg">No feature gating. No surprise fees. Pick your team size and go.</p>
      <p class="text-sm text-gray-500 mt-2">All prices in CAD · 14-day free trial · Cancel anytime</p>
    </div>

    <!-- Plans loaded dynamically from DB -->
    <div id="landing-pricing-grid" class="grid md:grid-cols-3 gap-6">
      <div class="text-center py-16 text-gray-500 col-span-3"><i class="fas fa-spinner fa-spin mr-2"></i>Loading plans...</div>
    </div>

    <!-- Money-back guarantee -->
    <div class="mt-8 flex flex-col sm:flex-row items-center justify-center gap-6 text-sm text-gray-400">
      <span><i class="fas fa-calendar-check text-green-400 mr-2"></i>14-day free trial — no credit card required</span>
      <span><i class="fas fa-times-circle text-blue-400 mr-2"></i>Cancel anytime — no contracts</span>
      <span><i class="fas fa-lock text-purple-400 mr-2"></i>Secure payments via Stripe</span>
    </div>
    <p class="text-center text-gray-600 text-xs mt-4">*Stats sourced from American Payroll Association and Robert Half workforce survey</p>
  </div>
</section>

<!-- ── PAIN POINT CALLOUT ─────────────────────────────────────────────────────── -->
<section class="py-16 bg-gray-950 border-y border-white/5">
  <div class="max-w-4xl mx-auto px-5 text-center">
    <h2 class="text-3xl font-black mb-3">Still using paper timesheets?</h2>
    <p class="text-gray-400 text-lg mb-8 max-w-2xl mx-auto">Paper timesheets are a worker's best friend — and your worst enemy. They're easy to fake, impossible to audit, and cost you more than you think.</p>
    <div class="grid md:grid-cols-4 gap-4">
      <div class="bg-gray-900 rounded-xl p-4 border border-white/5">
        <div class="text-red-400 font-black text-2xl mb-1">❌</div>
        <p class="text-sm text-gray-300 font-medium">Paper timesheets</p>
        <p class="text-xs text-gray-500 mt-1">Easy to fake, no GPS, no audit trail</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-white/5">
        <div class="text-red-400 font-black text-2xl mb-1">❌</div>
        <p class="text-sm text-gray-300 font-medium">Basic clock-in apps</p>
        <p class="text-xs text-gray-500 mt-1">No GPS = still faked from home</p>
      </div>
      <div class="bg-gray-900 rounded-xl p-4 border border-white/5">
        <div class="text-red-400 font-black text-2xl mb-1">❌</div>
        <p class="text-sm text-gray-300 font-medium">Punch clocks</p>
        <p class="text-xs text-gray-500 mt-1">Expensive hardware, buddy punching</p>
      </div>
      <div class="bg-green-950/40 rounded-xl p-4 border border-green-800/40">
        <div class="text-green-400 font-black text-2xl mb-1">✅</div>
        <p class="text-sm text-white font-bold">ClockInProof</p>
        <p class="text-xs text-green-400 mt-1">GPS verified · Fraud blocked · Proof stored</p>
      </div>
    </div>
  </div>
</section>

<!-- ── FAQ ────────────────────────────────────────────────────────────────────── -->
<section id="faq" class="py-24 bg-gray-900">
  <div class="max-w-3xl mx-auto px-5">
    <h2 class="text-4xl font-black text-center mb-14">Questions? <span class="text-blue-400">Answered.</span></h2>
    <div class="space-y-3" id="faq-list">

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          Do my workers need to download an app?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          No. Workers receive a link via SMS. They open it in their phone's browser — Chrome, Safari, anything. No App Store, no Google Play, no passwords to remember. They set a 4-digit PIN and that's their login.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          What if a worker tries to clock in from home?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          They get blocked. You receive an instant alert showing their GPS location vs. the job site. You can approve it if there's a legitimate reason (e.g., material pickup offsite), or deny it. Your worker is notified immediately either way.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          What if a worker forgets to clock out?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          ClockInProof auto clock-out kicks in. If the worker's GPS moves outside the job site for more than your threshold (default 30 min), they're automatically clocked out. You can also manually clock out any worker from the admin panel at any time.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          Can I manage multiple job sites at the same time?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          Yes — unlimited job sites on all plans. Workers pick their site from a dropdown when clocking in. Each site has its own geofence, radius, and history. You can see all active workers across all sites on one live map.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          Can workers spoof their GPS location?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          ClockInProof has built-in GPS spoofing detection. It checks for mock location apps, impossible travel speeds (clocked out in Ottawa, clocked in 200km away 10 minutes later), and GPS drift patterns. Suspicious sessions are flagged for admin review.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          How does the 14-day free trial work?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          Sign up with your company name and email. No credit card required. You get full access to all features for 14 days. At the end of the trial, enter your payment info to continue — or simply don't, and your account pauses. No automatic charges.
        </div>
      </div>

      <div class="faq-item bg-gray-800 rounded-xl overflow-hidden border border-white/5">
        <button onclick="toggleFaq(this)" class="w-full text-left px-6 py-4 font-semibold flex justify-between items-center hover:bg-gray-750 transition text-sm">
          Does it work in Canada and the US?
          <i class="fas fa-chevron-down text-gray-400 transition-transform flex-shrink-0 ml-4"></i>
        </button>
        <div class="faq-body hidden px-6 pb-5 text-gray-400 text-sm leading-relaxed">
          Yes. ClockInProof works anywhere. Canadian statutory holiday pay rules are built in for all provinces. US federal and state overtime rules are on the roadmap. GPS works globally.
        </div>
      </div>

    </div>
  </div>
</section>

<!-- ── FINAL CTA ───────────────────────────────────────────────────────────────── -->
<section class="gradient-hero py-24 border-t border-white/10">
  <div class="max-w-3xl mx-auto px-5 text-center">
    <div class="inline-flex items-center gap-2 bg-red-600/20 border border-red-500/30 rounded-full px-4 py-1.5 text-red-300 text-xs font-bold uppercase tracking-wider mb-6">
      <i class="fas fa-stop-circle"></i> Stop Losing Money Today
    </div>
    <h2 class="text-4xl md:text-5xl font-black mb-5 leading-tight">
      Your crew clocks in tomorrow.<br/>
      <span class="text-blue-400">You'll know exactly where they are.</span>
    </h2>
    <p class="text-gray-300 text-lg mb-10 max-w-xl mx-auto">14 days free. No credit card. Setup in 5 minutes. Cancel if you don't catch time theft within a month — we'd be shocked.</p>
    <div class="flex flex-col sm:flex-row gap-4 justify-center">
      <a href="/signup?plan=growth" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-10 py-4 rounded-xl text-lg transition glow-blue">
        <i class="fas fa-shield-alt mr-2"></i>Start Free Trial
      </a>
      <a href="https://admin.clockinproof.com" class="border border-white/20 hover:border-white/40 text-white font-semibold px-10 py-4 rounded-xl text-lg transition">
        <i class="fas fa-sign-in-alt mr-2 text-blue-400"></i>Existing Customer Login
      </a>
    </div>
    <p class="text-gray-600 text-xs mt-5">Serving restoration, construction, HVAC, electrical, plumbing, fire suppression & all trades across Canada and the US</p>
  </div>
</section>

<!-- ── FOOTER ─────────────────────────────────────────────────────────────────── -->
<footer class="bg-gray-950 border-t border-white/5 py-14">
  <div class="max-w-6xl mx-auto px-5">
    <div class="grid md:grid-cols-5 gap-8 mb-10">
      <div class="md:col-span-2">
        <div class="flex items-center gap-2 mb-4">
          <img src="/static/icon-180.png" class="w-7 h-7 rounded-md" alt="ClockInProof" onerror="this.style.display='none'"/>
          <span class="font-black text-lg">ClockIn<span class="text-blue-400">Proof</span></span>
        </div>
        <p class="text-gray-500 text-sm leading-relaxed mb-4">GPS-verified time tracking that stops time theft for trades, restoration, HVAC, construction, and every field service industry.</p>
        <div class="flex gap-3">
          <span class="text-xs text-gray-600 bg-gray-900 px-2 py-1 rounded">🇨🇦 Canada</span>
          <span class="text-xs text-gray-600 bg-gray-900 px-2 py-1 rounded">🇺🇸 USA</span>
        </div>
      </div>
      <div>
        <h4 class="font-bold mb-4 text-xs uppercase tracking-wider text-gray-400">Product</h4>
        <ul class="space-y-2.5 text-sm text-gray-500">
          <li><a href="#features" class="hover:text-white transition">Features</a></li>
          <li><a href="#pricing" class="hover:text-white transition">Pricing</a></li>
          <li><a href="#how-it-works" class="hover:text-white transition">How It Works</a></li>
          <li><a href="#faq" class="hover:text-white transition">FAQ</a></li>
        </ul>
      </div>
      <div>
        <h4 class="font-bold mb-4 text-xs uppercase tracking-wider text-gray-400">Access</h4>
        <ul class="space-y-2.5 text-sm text-gray-500">
          <li><a href="/signup" class="hover:text-white transition">Start Free Trial</a></li>
          <li><a href="https://admin.clockinproof.com" class="hover:text-white transition">Admin Login</a></li>
          <li><a href="https://app.clockinproof.com" class="hover:text-white transition">Worker Login</a></li>
        </ul>
      </div>
      <div>
        <h4 class="font-bold mb-4 text-xs uppercase tracking-wider text-gray-400">Company</h4>
        <ul class="space-y-2.5 text-sm text-gray-500">
          <li><a href="/privacy" class="hover:text-white transition">Privacy Policy</a></li>
          <li><a href="/terms" class="hover:text-white transition">Terms of Service</a></li>
          <li><a href="mailto:support@clockinproof.com" class="hover:text-white transition">support@clockinproof.com</a></li>
        </ul>
      </div>
    </div>
    <div class="border-t border-white/5 pt-8 flex flex-col md:flex-row justify-between items-center gap-3">
      <p class="text-gray-600 text-xs">© 2026 ClockInProof Inc. All rights reserved. · timepiracy.com · stoptimepiracy.com</p>
      <p class="text-gray-700 text-xs">Built on Cloudflare Edge · GPS by OpenStreetMap · Payments by Stripe</p>
    </div>
  </div>
</footer>

<script>
function toggleFaq(btn) {
  const body = btn.nextElementSibling
  const icon = btn.querySelector('i.fa-chevron-down')
  const isOpen = !body.classList.contains('hidden')
  document.querySelectorAll('.faq-body').forEach(b => b.classList.add('hidden'))
  document.querySelectorAll('.faq-item button i.fa-chevron-down').forEach(i => i.style.transform = '')
  if (!isOpen) {
    body.classList.remove('hidden')
    if (icon) icon.style.transform = 'rotate(180deg)'
  }
}

// ── Dynamic pricing from DB ──────────────────────────────────────────────────
(async function loadLandingPricing() {
  const grid = document.getElementById('landing-pricing-grid')
  if (!grid) return
  try {
    const res = await fetch('/api/plans')
    const data = await res.json()
    const plans = data.plans || []
    if (!plans.length) { grid.innerHTML = '<div class="text-center py-16 text-gray-500 col-span-3">No plans available</div>'; return }

    const styles = [
      { border:'border-white/10', priceColor:'text-white', labelColor:'text-gray-500', popular:false, btnClass:'border border-white/20 hover:border-blue-500 hover:bg-blue-600/10 text-white' },
      { border:'pricing-popular', priceColor:'text-blue-400', labelColor:'text-blue-400', popular:true,  btnClass:'bg-blue-600 hover:bg-blue-500 text-white glow-blue' },
      { border:'border-white/10', priceColor:'text-white', labelColor:'text-gray-500', popular:false, btnClass:'border border-white/20 hover:border-blue-500 hover:bg-blue-600/10 text-white' },
    ]
    grid.innerHTML = plans.map((p, i) => {
      const st       = styles[i] || styles[0]
      const price    = (p.price_monthly / 100).toFixed(0)
      const workers  = p.max_workers >= 999 ? '<strong class="text-white">Unlimited workers</strong>' : 'Up to <strong class="text-white">' + p.max_workers + ' workers</strong>'
      const features = (p.features || '').split(',').filter(Boolean)
      const slug     = (p.name || 'starter').toLowerCase()
      return '<div class="bg-gray-950 ' + st.border + ' rounded-2xl p-8 flex flex-col">' +
        '<div class="mb-6">' +
          '<div class="text-xs font-bold ' + st.labelColor + ' uppercase tracking-widest mb-2">' + p.name + '</div>' +
          '<div class="text-5xl font-black ' + st.priceColor + ' mb-1">$' + price + '<span class="text-xl font-normal text-gray-400"> CAD/mo</span></div>' +
          '<p class="text-gray-400 text-sm">' + workers + '</p>' +
        '</div>' +
        '<ul class="space-y-3 text-sm text-gray-300 mb-8 flex-1">' +
          features.map(f => '<li class="flex gap-2"><i class="fas fa-check-circle text-green-400 mt-0.5 flex-shrink-0"></i>' + f.trim() + '</li>').join('') +
        '</ul>' +
        '<a href="/signup?plan=' + slug + '" class="block text-center font-bold py-3.5 rounded-xl transition text-sm ' + st.btnClass + '">Start Free 14-Day Trial</a>' +
      '</div>'
    }).join('')
  } catch(e) {
    // Fallback: keep static content if API fails
    grid.innerHTML = '<div class="text-center py-8 text-gray-500 col-span-3 text-sm">Pricing temporarily unavailable. <a href="/signup" class="text-blue-400 underline">Sign up here</a>.</div>'
  }
})()
</script>

</body>
</html>\``
}


// ─── WORKER APP ───────────────────────────────────────────────────────────────
function getWorkerHTML(tenant?: any): string {
  const companyName = tenant?.company_name || 'ClockInProof'
  const primaryColor = tenant?.primary_color || '#4F46E5'
  const logoUrl = tenant?.logo_url || ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
  <meta name="theme-color" content="${primaryColor}"/>
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
  <meta name="apple-mobile-web-app-title" content="${companyName}"/>
  <title>${companyName} — Clock In/Out</title>
  <link rel="manifest" href="/static/manifest-worker.json"/>
  <link rel="apple-touch-icon" href="/static/icon-180.png"/>
  <link rel="apple-touch-icon" sizes="192x192" href="/static/icon-192.png"/>
  <link rel="icon" type="image/png" sizes="192x192" href="/static/icon-192.png"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    :root {
      --primary: ${primaryColor};
      --wk-bg:        #f1f5f9;
      --wk-card:      #ffffff;
      --wk-card2:     #f8fafc;
      --wk-border:    #e2e8f0;
      --wk-text:      #1e293b;
      --wk-text2:     #64748b;
      --wk-text3:     #94a3b8;
      --wk-nav-bg:    #ffffff;
      --wk-nav-border:#e5e7eb;
      --wk-input-bg:  #f9fafb;
    }
    html.dark {
      --wk-bg:        #0f172a;
      --wk-card:      #1e293b;
      --wk-card2:     #162032;
      --wk-border:    #334155;
      --wk-text:      #f1f5f9;
      --wk-text2:     #94a3b8;
      --wk-text3:     #64748b;
      --wk-nav-bg:    #1e293b;
      --wk-nav-border:#334155;
      --wk-input-bg:  #0f172a;
    }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--wk-bg) !important; color: var(--wk-text) !important; transition: background 0.2s, color 0.2s; }
    /* Worker dark mode overrides */
    html.dark #wk-bottom-nav                               { background: var(--wk-nav-bg) !important; border-color: var(--wk-nav-border) !important; }
    html.dark [style*="background:#fff"]                   { background: var(--wk-card) !important; }
    html.dark [style*="background:#f8fafc"]                { background: var(--wk-card2) !important; }
    html.dark [style*="background:#f1f5f9"]                { background: var(--wk-card2) !important; }
    html.dark [style*="color:#1e293b"]                     { color: var(--wk-text) !important; }
    html.dark [style*="color:#64748b"]                     { color: var(--wk-text2) !important; }
    html.dark [style*="color:#94a3b8"]                     { color: var(--wk-text3) !important; }
    html.dark [style*="border-color:#e2e8f0"], html.dark [style*="border:1.5px solid #e2e8f0"] { border-color: var(--wk-border) !important; }
    html.dark input, html.dark select, html.dark textarea  { background: var(--wk-input-bg) !important; color: var(--wk-text) !important; border-color: var(--wk-border) !important; }
    html.dark .bg-gray-50                                  { background: var(--wk-card2) !important; }
    html.dark .bg-white                                    { background: var(--wk-card) !important; }
    html.dark .text-gray-800, html.dark .text-gray-900     { color: var(--wk-text) !important; }
    html.dark .text-gray-500, html.dark .text-gray-600     { color: var(--wk-text2) !important; }
    html.dark .border-gray-200                             { border-color: var(--wk-border) !important; }
    html.dark #status-card, html.dark .rounded-2xl.shadow-sm { background: var(--wk-card) !important; }
    html.dark .day-group                                   { border-color: #3b82f6; background: var(--wk-card2) !important; }
    .clock-btn { transition: all 0.2s ease; }
    .clock-btn:active { transform: scale(0.97); }
    #map { height: 200px; border-radius: 12px; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
    .slide-up { animation: slideUp 0.3s ease; }
    @keyframes slideUp { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
    .spinner { animation: spin 1s linear infinite; }
    @keyframes spin { to{transform:rotate(360deg)} }
    .modal-bg { backdrop-filter: blur(4px); }
    .day-group { border-left: 3px solid #3b82f6; }
  </style>
  <script>window.__TENANT__ = ${JSON.stringify({ company_name: companyName, primary_color: primaryColor, logo_url: logoUrl })};
    // Init theme before paint to prevent flash
    (function(){
      const saved = localStorage.getItem('cip_theme');
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (saved === 'dark' || (!saved && sysDark)) document.documentElement.classList.add('dark');
    })();
  </script>
</head>
<body class="bg-gray-50 min-h-screen">

<!-- ── Add to Home Screen Banner (shown once, dismissed to localStorage) ── -->
<div id="a2hs-banner" class="hidden fixed bottom-0 left-0 right-0 z-50 p-3">
  <div class="bg-blue-700 text-white rounded-2xl shadow-2xl p-4 flex items-center gap-3 max-w-lg mx-auto">
    <div class="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center flex-shrink-0 text-xl">📲</div>
    <div class="flex-1 min-w-0">
      <p class="font-bold text-sm">Save app to Home Screen</p>
      <p class="text-blue-200 text-xs mt-0.5">
        <span class="ios-hint">Tap <strong>Share</strong> → <strong>Add to Home Screen</strong></span>
        <span class="android-hint hidden">Tap <strong>⋮</strong> → <strong>Add to Home Screen</strong></span>
      </p>
    </div>
    <button onclick="dismissA2HS()" class="text-blue-200 hover:text-white p-1 flex-shrink-0">
      <i class="fas fa-times text-lg"></i>
    </button>
  </div>
</div>

<!-- Register Screen -->
<div id="screen-register" class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm slide-up">
    <div class="text-center mb-8">
      <div class="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
        <i class="fas fa-clock text-white text-3xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">ClockInProof</h1>
      <p class="text-gray-500 text-sm mt-1">Track your work hours & location</p>
    </div>
    <div class="bg-white rounded-2xl shadow-sm p-6 space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Your Name</label>
        <input id="reg-name" type="text" placeholder="Enter your full name"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
        <input id="reg-phone" type="tel" placeholder="+1 234 567 8900"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">PIN (4–8 digits)</label>
        <input id="reg-pin" type="password" placeholder="Create a 4–8 digit PIN" maxlength="8"
          inputmode="numeric" pattern="[0-9]{4,8}"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"/>
      </div>
      <button onclick="registerWorker()" id="reg-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl clock-btn shadow-md">
        <i class="fas fa-user-plus mr-2"></i>Get Started
      </button>
      <button onclick="showLogin()" class="w-full bg-gray-100 hover:bg-gray-200 text-blue-700 font-semibold py-3 rounded-xl text-sm border border-blue-200">
        <i class="fas fa-sign-in-alt mr-2"></i>Already registered? Sign In
      </button>
    </div>
  </div>
</div>

<!-- Login Screen -->
<div id="screen-login" class="hidden min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm slide-up">
    <div class="text-center mb-8">
      <div class="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
        <i class="fas fa-clock text-white text-3xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">Welcome Back</h1>
      <p class="text-gray-500 text-sm mt-1">Sign in to track your time</p>
    </div>
    <div class="bg-white rounded-2xl shadow-sm p-6 space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
        <input id="login-phone" type="tel" placeholder="+1 234 567 8900"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">PIN</label>
        <input id="login-pin" type="password" placeholder="Enter your PIN" maxlength="8"
          inputmode="numeric" pattern="[0-9]{4,8}"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      </div>
      <button onclick="loginWorker()" id="login-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl clock-btn shadow-md">
        <i class="fas fa-sign-in-alt mr-2"></i>Sign In
      </button>
      <button onclick="showForgotPin()" class="w-full text-gray-500 hover:text-blue-600 font-medium py-2 text-sm transition-colors">
        <i class="fas fa-key mr-1"></i>Forgot PIN?
      </button>
      <button onclick="showRegister()" class="w-full text-blue-600 font-medium py-2 text-sm">
        New user? Register here
      </button>
    </div>
  </div>
</div>

<!-- Main Worker Screen -->
<div id="screen-main" class="hidden bg-gray-50" style="display:none;flex-direction:column;height:100dvh;height:100vh;overflow:hidden">
  <!-- Header -->
  <div class="bg-blue-600 text-white px-4 py-5 shadow-md">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-blue-200 text-xs uppercase tracking-wider">Logged in as</p>
        <h2 id="worker-name-display" class="text-xl font-bold"></h2>
        <p id="worker-phone-display" class="text-blue-200 text-sm"></p>
      </div>
      <div class="text-right">
        <p class="text-blue-200 text-xs">Rate</p>
        <p id="worker-rate-display" class="text-lg font-bold"></p>
        <button onclick="logout()" class="text-blue-200 text-xs mt-1 hover:text-white">
          <i class="fas fa-sign-out-alt mr-1"></i>Logout
        </button>
      </div>
    </div>
  </div>

  <!-- ── Bottom Tab Navigation ──────────────────────────────────────────── -->
  <nav id="wk-bottom-nav" style="position:fixed;bottom:0;left:0;right:0;z-index:100;background:#fff;border-top:1px solid #e5e7eb;display:flex;align-items:stretch;box-shadow:0 -2px 12px rgba(0,0,0,0.08)">
    <button onclick="wkShowTab('clock')" id="wk-nav-clock" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px 10px;border:none;background:none;cursor:pointer;color:#4f46e5;font-size:10px;font-weight:700;gap:3px;border-top:2px solid #4f46e5">
      <i class="fas fa-clock" style="font-size:18px"></i>Clock In
    </button>
    <button onclick="wkShowTab('dispatches')" id="wk-nav-dispatches" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px 10px;border:none;background:none;cursor:pointer;color:#9ca3af;font-size:10px;font-weight:600;gap:3px;border-top:2px solid transparent;position:relative">
      <i class="fas fa-truck" style="font-size:18px"></i>Jobs
      <span id="wk-dispatch-badge" style="display:none;position:absolute;top:6px;right:calc(50% - 14px);background:#ef4444;color:#fff;font-size:9px;font-weight:800;padding:1px 5px;border-radius:20px;line-height:1.4">0</span>
    </button>
    <button onclick="wkShowTab('history')" id="wk-nav-history" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px 10px;border:none;background:none;cursor:pointer;color:#9ca3af;font-size:10px;font-weight:600;gap:3px;border-top:2px solid transparent">
      <i class="fas fa-receipt" style="font-size:18px"></i>Pay Period
    </button>
    <button onclick="wkShowTab('profile')" id="wk-nav-profile" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px 10px;border:none;background:none;cursor:pointer;color:#9ca3af;font-size:10px;font-weight:600;gap:3px;border-top:2px solid transparent">
      <i class="fas fa-user-circle" style="font-size:18px"></i>Profile
    </button>
  </nav>

  <!-- ── Tab Panels ──────────────────────────────────────────────────────── -->

  <!-- CLOCK TAB -->
  <div id="wk-tab-clock" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:80px">
  <div class="p-4 space-y-4 max-w-lg mx-auto">
    <!-- Status Card -->
    <div id="status-card" class="bg-white rounded-2xl shadow-sm p-5 slide-up">
      <div class="flex items-center gap-3 mb-3">
        <div id="status-dot" class="w-3 h-3 rounded-full bg-gray-300"></div>
        <span id="status-text" class="font-semibold text-gray-700">Not Clocked In</span>
      </div>
      <!-- Active job info banner -->
      <div id="active-job-banner" class="hidden bg-blue-50 border border-blue-100 rounded-xl p-3 mb-3">
        <p class="text-xs text-blue-500 font-medium mb-0.5"><i class="fas fa-briefcase mr-1"></i>Current Job</p>
        <p id="active-job-location" class="text-sm font-bold text-blue-800"></p>
        <p id="active-job-desc" class="text-xs text-blue-600 mt-0.5"></p>
      </div>
      <div id="clock-in-info" class="hidden">
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div class="bg-blue-50 rounded-xl p-3">
            <p class="text-xs text-blue-600 font-medium">Clock In</p>
            <p id="session-start-time" class="text-sm font-bold text-blue-800 mt-0.5"></p>
          </div>
          <div class="bg-green-50 rounded-xl p-3">
            <p class="text-xs text-green-600 font-medium">Duration</p>
            <p id="session-duration" class="text-sm font-bold text-green-800 mt-0.5">0h 0m</p>
          </div>
        </div>
        <div class="bg-yellow-50 rounded-xl p-3">
          <p class="text-xs text-yellow-600 font-medium">Estimated Earnings</p>
          <p id="session-earnings" class="text-lg font-bold text-yellow-800 mt-0.5">$0.00</p>
        </div>
      </div>
    </div>

    <!-- ── GUARDRAIL WARNING BANNERS ─────────────────────────────── -->
    <!-- Drift warning: worker has left the job site -->
    <div id="banner-drift" class="hidden bg-orange-50 border-2 border-orange-400 rounded-2xl p-4 shadow-sm">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-walking text-orange-500 text-lg"></i>
        </div>
        <div class="flex-1">
          <p class="text-sm font-bold text-orange-700">You have left the job site</p>
          <p id="banner-drift-msg" class="text-xs text-orange-600 mt-0.5"></p>
          <p class="text-xs text-orange-500 mt-1">Your admin has been notified. Please return or clock out.</p>
        </div>
        <button onclick="openClockoutConfirm()" class="bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold px-3 py-2 rounded-xl flex-shrink-0">
          Clock Out
        </button>
      </div>
    </div>

    <!-- Away warning: GPS not updating — phone likely left behind or off -->
    <div id="banner-away" class="hidden bg-yellow-50 border-2 border-yellow-400 rounded-2xl p-4 shadow-sm">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-satellite-dish text-yellow-500 text-lg animate-pulse"></i>
        </div>
        <div class="flex-1">
          <p class="text-sm font-bold text-yellow-700">GPS signal lost</p>
          <p id="banner-away-msg" class="text-xs text-yellow-600 mt-0.5">Your location hasn't updated in a while. Are you still at work?</p>
          <div class="flex gap-2 mt-2">
            <button onclick="confirmStillWorking()" class="bg-yellow-500 hover:bg-yellow-600 text-white text-xs font-bold px-3 py-1.5 rounded-lg">
              Yes, still here
            </button>
            <button onclick="openClockoutConfirm()" class="bg-white border border-yellow-400 text-yellow-700 text-xs font-medium px-3 py-1.5 rounded-lg">
              Clock Out
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Max shift warning: approaching shift limit -->
    <div id="banner-maxshift" class="hidden bg-red-50 border-2 border-red-400 rounded-2xl p-4 shadow-sm">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-clock text-red-500 text-lg"></i>
        </div>
        <div class="flex-1">
          <p class="text-sm font-bold text-red-700">Shift limit approaching</p>
          <p id="banner-maxshift-msg" class="text-xs text-red-600 mt-0.5"></p>
          <p class="text-xs text-red-400 mt-1">You will be automatically clocked out when the limit is reached.</p>
        </div>
        <button onclick="openClockoutConfirm()" class="bg-red-500 hover:bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-xl flex-shrink-0">
          Clock Out Now
        </button>
      </div>
    </div>
    <div class="bg-white rounded-2xl shadow-sm p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-gray-700 flex items-center gap-2">
          <i class="fas fa-map-marker-alt text-red-500"></i> Current Location
        </h3>
        <div class="flex items-center gap-2">
          <button id="toggle-map-btn" onclick="toggleMap()" class="hidden text-blue-600 text-xs font-medium hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg border border-blue-100 transition-colors">
            <i class="fas fa-map mr-1"></i>View Map
          </button>
          <button onclick="getLocation()" class="text-gray-400 text-sm hover:text-gray-600 p-1">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
      </div>
      <div id="location-status" class="text-sm text-gray-500">
        <i class="fas fa-circle-notch spinner mr-1"></i> Getting location...
      </div>
      <!-- Collapsible map — hidden by default, toggled by View Map button -->
      <!-- On mobile this renders as a fixed overlay; on desktop it's inline below the location row -->
      <div id="map-wrapper" class="hidden mt-3">
        <!-- Mobile backdrop — tap outside map to close -->
        <div id="map-backdrop" class="fixed inset-0 bg-black/40 z-30 lg:hidden" onclick="closeMap()"></div>
        <!-- Map card — fixed on mobile, inline on desktop -->
        <div class="relative fixed bottom-0 left-0 right-0 z-40 bg-white rounded-t-2xl shadow-2xl p-3 lg:static lg:rounded-xl lg:shadow-none lg:p-0 lg:z-auto">
          <div class="flex items-center justify-between mb-2 lg:mb-1.5">
            <p class="text-xs text-gray-500 font-semibold flex items-center gap-1">
              <i class="fas fa-crosshairs text-blue-500"></i> Your current position
            </p>
            <button onclick="closeMap()" class="text-gray-400 hover:text-gray-600 text-xs flex items-center gap-1 bg-gray-100 hover:bg-gray-200 px-2.5 py-1.5 rounded-lg transition-colors font-medium">
              <i class="fas fa-times mr-1"></i>Close
            </button>
          </div>
          <div id="map" class="rounded-xl overflow-hidden" style="height:220px"></div>
          <p class="text-[10px] text-gray-400 mt-1.5 text-center">© OpenStreetMap contributors</p>
        </div>
      </div>
    </div>

    <!-- Clock In/Out Button -->
    <button id="clock-btn" onclick="handleClockBtn()"
      class="w-full py-5 rounded-2xl text-white text-xl font-bold shadow-lg clock-btn flex items-center justify-center gap-3 bg-green-500 hover:bg-green-600">
      <i id="clock-btn-icon" class="fas fa-play-circle text-2xl"></i>
      <span id="clock-btn-text">Clock In</span>
    </button>

    <!-- My Stats -->
    <div class="bg-white rounded-2xl shadow-sm p-4">
      <h3 class="font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <i class="fas fa-chart-bar text-blue-500"></i> My Stats
      </h3>
      <div class="grid grid-cols-3 gap-3">
        <div class="text-center">
          <p class="text-2xl font-bold text-blue-600" id="stat-sessions">–</p>
          <p class="text-xs text-gray-500">Sessions</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-bold text-green-600" id="stat-hours">–</p>
          <p class="text-xs text-gray-500">Total Hrs</p>
        </div>
        <div class="text-center">
          <p class="text-2xl font-bold text-yellow-600" id="stat-earnings">–</p>
          <p class="text-xs text-gray-500">Earned</p>
        </div>
      </div>
    </div>

    <!-- ── My Hours & Pay ─────────────────────────────────────────────── -->
    <div class="bg-white rounded-2xl shadow-sm p-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-700 flex items-center gap-2">
          <i class="fas fa-wallet text-emerald-500"></i> My Hours &amp; Pay
        </h3>
        <!-- Period selector tabs -->
        <div class="flex gap-1 bg-gray-100 p-1 rounded-xl">
          <button onclick="switchPayView('today')" id="pv-today"
            class="px-2.5 py-1 text-xs font-medium rounded-lg bg-white shadow-sm text-gray-700">Day</button>
          <button onclick="switchPayView('week')" id="pv-week"
            class="px-2.5 py-1 text-xs font-medium rounded-lg text-gray-500">Week</button>
          <button onclick="switchPayView('month')" id="pv-month"
            class="px-2.5 py-1 text-xs font-medium rounded-lg text-gray-500">Month</button>
          <button onclick="switchPayView('period')" id="pv-period"
            class="px-2.5 py-1 text-xs font-medium rounded-lg text-gray-500">Period</button>
        </div>
      </div>

      <!-- Big hours + earnings display -->
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="bg-blue-50 rounded-2xl p-4 text-center">
          <p class="text-xs text-blue-500 font-medium uppercase tracking-wider mb-1">Hours</p>
          <p class="text-3xl font-bold text-blue-700" id="pay-hours">–</p>
          <p class="text-xs text-blue-400 mt-1" id="pay-hours-label">Today</p>
        </div>
        <div class="bg-emerald-50 rounded-2xl p-4 text-center">
          <p class="text-xs text-emerald-500 font-medium uppercase tracking-wider mb-1">Gross Pay</p>
          <p class="text-3xl font-bold text-emerald-700" id="pay-gross">–</p>
          <p class="text-xs text-emerald-400 mt-1" id="pay-gross-label">@ $<span id="pay-rate">–</span>/hr</p>
        </div>
      </div>

      <!-- Next Pay countdown (pay period view) -->
      <div id="pay-period-banner" class="hidden bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-100 rounded-2xl p-4 mb-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-xs text-purple-500 font-medium uppercase tracking-wider">Next Payday</p>
            <p class="text-lg font-bold text-purple-800 mt-0.5" id="pay-next-date">–</p>
            <p class="text-xs text-purple-500 mt-0.5" id="pay-next-countdown">–</p>
          </div>
          <div class="w-14 h-14 bg-purple-100 rounded-2xl flex items-center justify-center">
            <i class="fas fa-money-check-alt text-purple-500 text-2xl"></i>
          </div>
        </div>
        <div class="mt-3 pt-3 border-t border-purple-100">
          <div class="flex justify-between text-xs text-purple-600">
            <span>Pay period:</span>
            <span id="pay-period-range">–</span>
          </div>
          <div class="flex justify-between text-xs text-purple-600 mt-1">
            <span>Hours this period:</span>
            <span class="font-bold" id="pay-period-hours">–</span>
          </div>
          <div class="flex justify-between text-xs text-purple-600 mt-1">
            <span>Est. gross this period:</span>
            <span class="font-bold text-emerald-600" id="pay-period-gross">–</span>
          </div>
        </div>
      </div>

      <!-- Daily breakdown (shown for week/month/period views) -->
      <div id="pay-daily-breakdown" class="hidden">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Daily Breakdown</p>
        <div id="pay-daily-list" class="space-y-1.5"></div>
      </div>

      <!-- Empty state -->
      <div id="pay-empty" class="hidden text-center py-4">
        <i class="fas fa-calendar-times text-gray-200 text-3xl mb-2"></i>
        <p class="text-gray-400 text-sm">No hours recorded yet</p>
      </div>
    </div>

    <!-- Work Log by Day -->
    <div class="bg-white rounded-2xl shadow-sm p-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-gray-700 flex items-center gap-2">
          <i class="fas fa-calendar-alt text-purple-500"></i> Work Log
        </h3>
        <div class="flex gap-2">
          <button onclick="showWorkerView('log')" id="view-log-btn"
            class="px-3 py-1.5 text-xs font-medium rounded-xl bg-purple-600 text-white">Log</button>
          <button onclick="showWorkerView('calendar')" id="view-cal-btn"
            class="px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-100 text-gray-600">Calendar</button>
        </div>
      </div>

      <!-- List view -->
      <div id="view-log-panel">
        <div id="work-log-by-day" class="space-y-4">
          <p class="text-gray-400 text-sm text-center py-4">No sessions yet</p>
        </div>
      </div>

      <!-- Calendar view -->
      <div id="view-cal-panel" class="hidden">
        <div class="flex items-center justify-between mb-3">
          <button onclick="workerCalPrev()" class="w-8 h-8 bg-gray-100 hover:bg-gray-200 rounded-xl flex items-center justify-center">
            <i class="fas fa-chevron-left text-xs"></i>
          </button>
          <span id="worker-cal-label" class="font-bold text-gray-700 text-sm"></span>
          <button onclick="workerCalNext()" class="w-8 h-8 bg-gray-100 hover:bg-gray-200 rounded-xl flex items-center justify-center">
            <i class="fas fa-chevron-right text-xs"></i>
          </button>
        </div>
        <!-- Day headers -->
        <div class="grid grid-cols-7 mb-1 gap-0.5">
          <div class="text-center text-xs text-gray-400 py-1">S</div>
          <div class="text-center text-xs text-gray-400 py-1">M</div>
          <div class="text-center text-xs text-gray-400 py-1">T</div>
          <div class="text-center text-xs text-gray-400 py-1">W</div>
          <div class="text-center text-xs text-gray-400 py-1">T</div>
          <div class="text-center text-xs text-gray-400 py-1">F</div>
          <div class="text-center text-xs text-gray-400 py-1">S</div>
        </div>
        <div id="worker-cal-grid" class="grid grid-cols-7 gap-0.5"></div>
        <!-- Month stats -->
        <div id="worker-cal-stats" class="mt-3 grid grid-cols-3 gap-2"></div>
        <!-- Holidays this month -->
        <div id="worker-cal-holidays" class="mt-2"></div>
      </div>
    </div>

    <div class="text-center py-2 pb-4">
      <a href="/admin" class="text-gray-400 text-xs hover:text-gray-600">
        <i class="fas fa-shield-alt mr-1"></i>Admin Panel
      </a>
    </div>
  </div>
  </div><!-- /wk-tab-clock -->

  <!-- DISPATCHES TAB -->
  <div id="wk-tab-dispatches" style="display:none;flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:80px">
    <div class="p-4 max-w-lg mx-auto space-y-4">
      <div style="display:flex;align-items:center;justify-content:space-between;padding-top:4px">
        <div>
          <h2 style="font-size:17px;font-weight:800;color:#1e293b">My Jobs</h2>
          <p style="font-size:12px;color:#94a3b8;margin-top:1px">Dispatches sent to you by admin</p>
        </div>
        <button onclick="loadWkDispatches()" style="background:#f1f5f9;border:none;padding:7px 12px;border-radius:10px;font-size:12px;color:#64748b;cursor:pointer;font-weight:600">
          <i class="fas fa-sync-alt"></i> Refresh
        </button>
      </div>

      <!-- Pending dispatches — needs response -->
      <div id="wk-dispatches-pending" class="space-y-3"></div>

      <!-- Recent completed dispatches -->
      <div id="wk-dispatches-history">
        <p style="font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:.05em;margin-bottom:10px">Recent History (30 days)</p>
        <div id="wk-dispatches-history-list" class="space-y-2"></div>
      </div>

      <!-- Empty state -->
      <div id="wk-dispatches-empty" style="display:none;text-align:center;padding:40px 20px;color:#94a3b8">
        <i class="fas fa-truck" style="font-size:40px;margin-bottom:12px;opacity:.4"></i>
        <p style="font-size:15px;font-weight:600">No jobs yet</p>
        <p style="font-size:12px;margin-top:4px">Your admin will send jobs here via SMS dispatch</p>
      </div>
    </div>
  </div><!-- /wk-tab-dispatches -->

  <!-- PAY HISTORY TAB -->
  <div id="wk-tab-history" style="display:none;flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:80px">
    <div class="p-4 max-w-lg mx-auto space-y-4">
      <div style="padding-top:4px">
        <h2 style="font-size:17px;font-weight:800;color:#1e293b">Pay Period</h2>
        <p style="font-size:12px;color:#94a3b8;margin-top:1px" id="wk-hist-period-label">Loading...</p>
      </div>

      <!-- Summary card -->
      <div id="wk-hist-summary" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:20px;padding:20px;color:#fff">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          <div style="background:rgba(255,255,255,.15);border-radius:14px;padding:14px;text-align:center">
            <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.8;margin-bottom:4px">Total Hours</p>
            <p style="font-size:28px;font-weight:800" id="wk-hist-hours">–</p>
          </div>
          <div style="background:rgba(255,255,255,.15);border-radius:14px;padding:14px;text-align:center">
            <p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.8;margin-bottom:4px">Gross Pay</p>
            <p style="font-size:28px;font-weight:800" id="wk-hist-gross">–</p>
          </div>
        </div>
        <div style="background:rgba(255,255,255,.1);border-radius:12px;padding:12px;display:flex;align-items:center;justify-content:space-between">
          <div>
            <p style="font-size:10px;opacity:.7;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Next Payday</p>
            <p style="font-size:16px;font-weight:800;margin-top:2px" id="wk-hist-payday">–</p>
          </div>
          <div style="text-align:right">
            <p style="font-size:10px;opacity:.7;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Days Away</p>
            <p style="font-size:22px;font-weight:800" id="wk-hist-days-left">–</p>
          </div>
        </div>
      </div>

      <!-- Sessions list -->
      <div>
        <p style="font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:.05em;margin-bottom:10px">Shifts This Period</p>
        <div id="wk-hist-sessions" class="space-y-2"></div>
        <div id="wk-hist-empty" style="display:none;text-align:center;padding:32px 20px;color:#94a3b8">
          <i class="fas fa-calendar-times" style="font-size:36px;margin-bottom:10px;opacity:.4"></i>
          <p style="font-size:14px;font-weight:600">No shifts this period yet</p>
          <p style="font-size:12px;margin-top:4px">Clock in to start earning</p>
        </div>
      </div>
    </div>
  </div><!-- /wk-tab-history -->

  <!-- PROFILE TAB -->
  <div id="wk-tab-profile" style="display:none;flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:80px">
    <div class="p-4 max-w-lg mx-auto space-y-4">
      <div style="padding-top:4px">
        <h2 style="font-size:17px;font-weight:800;color:#1e293b">My Profile</h2>
      </div>
      <!-- Worker info card -->
      <div style="background:#fff;border-radius:20px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.07)">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
          <div style="width:56px;height:56px;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <i class="fas fa-user" style="font-size:22px;color:#fff"></i>
          </div>
          <div>
            <p style="font-size:17px;font-weight:800;color:#1e293b" id="wk-profile-name">–</p>
            <p style="font-size:13px;color:#64748b;margin-top:2px" id="wk-profile-phone">–</p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="background:#f8fafc;border-radius:12px;padding:12px">
            <p style="font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Pay Rate</p>
            <p style="font-size:16px;font-weight:800;color:#059669;margin-top:3px" id="wk-profile-rate">–</p>
          </div>
          <div style="background:#f8fafc;border-radius:12px;padding:12px">
            <p style="font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Status</p>
            <p style="font-size:16px;font-weight:800;color:#4f46e5;margin-top:3px" id="wk-profile-status">–</p>
          </div>
          <div style="background:#f8fafc;border-radius:12px;padding:12px">
            <p style="font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Total Sessions</p>
            <p style="font-size:16px;font-weight:800;color:#1e293b;margin-top:3px" id="wk-profile-sessions">–</p>
          </div>
          <div style="background:#f8fafc;border-radius:12px;padding:12px">
            <p style="font-size:10px;color:#94a3b8;text-transform:uppercase;font-weight:700;letter-spacing:.05em">All-Time Hours</p>
            <p style="font-size:16px;font-weight:800;color:#1e293b;margin-top:3px" id="wk-profile-hours">–</p>
          </div>
        </div>
      </div>
      <!-- Actions -->
      <div style="background:#fff;border-radius:20px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)">
        <p style="font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:.05em;margin-bottom:10px">Account</p>
        <div class="space-y-2">
          <button onclick="openDisputeModal(null)" style="width:100%;display:flex;align-items:center;gap:12px;padding:12px;background:#fef9f0;border:1.5px solid #fde68a;border-radius:14px;cursor:pointer;text-align:left">
            <i class="fas fa-flag" style="color:#f59e0b;font-size:16px;width:20px;text-align:center"></i>
            <div>
              <p style="font-size:13px;font-weight:700;color:#1e293b">Report an Issue</p>
              <p style="font-size:11px;color:#94a3b8;margin-top:1px">Wrong hours, GPS error, pay dispute</p>
            </div>
            <i class="fas fa-chevron-right" style="color:#d1d5db;margin-left:auto;font-size:12px"></i>
          </button>
          <button onclick="toggleTheme()" id="wk-theme-btn" style="width:100%;display:flex;align-items:center;gap:12px;padding:12px;background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:14px;cursor:pointer;text-align:left">
            <i id="wk-theme-icon" class="fas fa-moon" style="color:#0ea5e9;font-size:16px;width:20px;text-align:center"></i>
            <div>
              <p id="wk-theme-label" style="font-size:13px;font-weight:700;color:#1e293b">Dark Mode</p>
              <p style="font-size:11px;color:#94a3b8;margin-top:1px">Switch between light and dark</p>
            </div>
            <i class="fas fa-chevron-right" style="color:#d1d5db;margin-left:auto;font-size:12px"></i>
          </button>
          <button onclick="requestDeviceResetFromProfile()" style="width:100%;display:flex;align-items:center;gap:12px;padding:12px;background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;cursor:pointer;text-align:left">
            <i class="fas fa-mobile-alt" style="color:#f97316;font-size:16px;width:20px;text-align:center"></i>
            <div>
              <p style="font-size:13px;font-weight:700;color:#1e293b">Register New Device</p>
              <p style="font-size:11px;color:#94a3b8;margin-top:1px">New phone or tablet? Request a device reset</p>
            </div>
            <i class="fas fa-chevron-right" style="color:#d1d5db;margin-left:auto;font-size:12px"></i>
          </button>
          <button onclick="logout()" style="width:100%;display:flex;align-items:center;gap:12px;padding:12px;background:#fff5f5;border:1.5px solid #fecaca;border-radius:14px;cursor:pointer;text-align:left">
            <i class="fas fa-sign-out-alt" style="color:#ef4444;font-size:16px;width:20px;text-align:center"></i>
            <div>
              <p style="font-size:13px;font-weight:700;color:#1e293b">Sign Out</p>
              <p style="font-size:11px;color:#94a3b8;margin-top:1px">You can sign back in anytime</p>
            </div>
            <i class="fas fa-chevron-right" style="color:#d1d5db;margin-left:auto;font-size:12px"></i>
          </button>
        </div>
      </div>
      <div class="text-center pb-2">
        <a href="/admin" class="text-gray-400 text-xs hover:text-gray-600">
          <i class="fas fa-shield-alt mr-1"></i>Admin Panel
        </a>
      </div>
    </div>
  </div><!-- /wk-tab-profile -->

</div><!-- /screen-main -->

<!-- ── Clock In Job Details Modal ─────────────────────────────────────────── -->
<!-- ── Worker Clock-Out Confirmation Modal ────────────────────────────────── -->
<div id="clockout-confirm-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 modal-bg flex items-end justify-center z-50" onclick="if(event.target===this)cancelClockoutConfirm()">
  <div class="bg-white w-full max-w-lg rounded-t-3xl shadow-2xl slide-up overflow-hidden">
    <!-- Red header bar -->
    <div class="bg-gradient-to-r from-red-500 to-rose-600 px-6 pt-5 pb-6 text-center relative">
      <div class="w-10 h-1 bg-white bg-opacity-30 rounded-full mx-auto mb-4"></div>
      <div class="w-14 h-14 bg-white bg-opacity-20 rounded-full flex items-center justify-center mx-auto mb-3">
        <i class="fas fa-stop-circle text-white text-2xl"></i>
      </div>
      <h2 class="text-white text-xl font-bold">Clock Out?</h2>
      <p class="text-red-100 text-sm mt-1">This will end your current shift</p>
    </div>
    <!-- Session summary -->
    <div class="px-6 py-5 space-y-4">
      <div id="co-confirm-info" class="bg-gray-50 rounded-2xl p-4 space-y-2.5">
        <!-- filled by JS -->
      </div>
      <!-- Action buttons -->
      <div class="flex gap-3">
        <button type="button" onclick="cancelClockoutConfirm()"
          class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-4 rounded-2xl text-base transition-colors">
          <i class="fas fa-arrow-left mr-2"></i>Cancel
        </button>
        <button type="button" id="co-confirm-btn" onclick="doConfirmClockout()"
          class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-2xl text-base transition-colors shadow-lg shadow-red-200">
          <i class="fas fa-stop-circle mr-2"></i>Yes, Clock Out
        </button>
      </div>
      <p class="text-center text-xs text-gray-400 pb-1">Tap Cancel if you pressed this by accident</p>
    </div>
  </div>
</div>

<div id="job-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 modal-bg z-50 overflow-y-auto">
  <!-- Outer scroll container — centers on tall screens, scrolls on small ones -->
  <div class="flex items-center justify-center min-h-full p-4 pb-24">
  <div class="bg-white w-full max-w-lg rounded-3xl shadow-2xl flex flex-col" style="width:100%">

    <!-- Sticky header -->
    <div class="flex-shrink-0 px-6 pt-5 pb-4 border-b border-gray-100">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 bg-green-100 rounded-2xl flex items-center justify-center flex-shrink-0">
          <i class="fas fa-briefcase text-green-600 text-xl"></i>
        </div>
        <div>
          <h3 class="text-lg font-bold text-gray-800">Where are you working?</h3>
          <p class="text-gray-500 text-xs">Tell us about today's job before clocking in</p>
        </div>
        <button onclick="closeJobModal()" class="ml-auto w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-400 flex-shrink-0">
          <i class="fas fa-times text-sm"></i>
        </button>
      </div>
    </div>

    <!-- Scrollable body -->
    <div class="px-6 py-4 space-y-4">

      <!-- Job Location -->
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-map-marker-alt text-red-500 mr-1"></i>Job Location / Address
        </label>
        <div id="saved-sites-row" class="hidden mb-2">
          <select id="saved-sites-select" onchange="pickSavedSite(this.value)"
            class="w-full px-4 py-3 border-2 border-emerald-200 rounded-xl focus:outline-none focus:border-emerald-500 text-gray-800 text-sm bg-emerald-50">
            <option value="">📍 Pick a saved job site or activity...</option>
          </select>
        </div>
        <input id="job-location-input" type="text"
          placeholder="Start typing an address..."
          autocomplete="off"
          class="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 text-gray-800 text-sm"
          oninput="filterLocationSuggestions(this.value)"
          onblur="setTimeout(()=>document.getElementById('location-suggestions').classList.add('hidden'),200)"/>
        <div id="location-suggestions" class="hidden mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-20 max-h-40 overflow-y-auto"></div>
      </div>

      <!-- Tasks / Description -->
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-tasks text-blue-500 mr-1"></i>What are you doing today?
        </label>
        <textarea id="job-description-input" rows="3"
          placeholder="e.g. Installing floor tiles in bedroom, drywall in bathroom, painting hallway"
          class="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 text-gray-800 text-sm resize-none"></textarea>
        <p class="text-xs text-gray-400 mt-1">Be specific — this helps track what was done each day</p>
      </div>

      <!-- Quick task chips -->
      <div>
        <p class="text-xs text-gray-500 font-medium mb-2">Quick add tasks:</p>
        <div class="flex flex-wrap gap-2" id="task-chips">
          <button onclick="addChip('Flooring')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🪵 Flooring</button>
          <button onclick="addChip('Drywall')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🧱 Drywall</button>
          <button onclick="addChip('Painting')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🎨 Painting</button>
          <button onclick="addChip('Plumbing')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🔧 Plumbing</button>
          <button onclick="addChip('Electrical')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">⚡ Electrical</button>
          <button onclick="addChip('Tiling')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🏗️ Tiling</button>
          <button onclick="addChip('Cleanup')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🧹 Cleanup</button>
          <button onclick="addChip('Inspection')" class="chip-btn px-3 py-1.5 bg-gray-100 hover:bg-blue-100 text-gray-600 hover:text-blue-700 text-xs rounded-full border border-gray-200 hover:border-blue-300 transition-colors">🔍 Inspection</button>
        </div>
      </div>

      <!-- GPS capture indicator -->
      <div class="bg-gray-50 rounded-xl p-3 flex items-center gap-3">
        <i class="fas fa-map-marker-alt text-red-500"></i>
        <div class="flex-1">
          <p class="text-xs font-medium text-gray-700">GPS will be captured automatically</p>
          <p id="modal-gps-status" class="text-xs text-gray-400 mt-0.5">Getting your location...</p>
        </div>
      </div>

      <!-- Material Pickup: Destination + Return-to + ETA (hidden by default, shown via JS) -->
      <div id="pickup-fields" class="hidden space-y-3">
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p class="text-xs font-bold text-amber-800"><i class="fas fa-store mr-1"></i>Material Pickup Details</p>
          <p class="text-xs text-amber-600 mt-0.5">Enter the store and the job site you are returning to</p>
        </div>
        <!-- Store / destination -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1.5">
            <i class="fas fa-store text-amber-500 mr-1"></i>Where are you going? (store / supplier)
          </label>
          <input id="pickup-destination-input" type="text" placeholder="e.g. Home Depot, 1234 Baseline Rd"
            autocomplete="off" maxlength="200"
            class="w-full px-4 py-3 border-2 border-amber-200 rounded-xl focus:outline-none focus:border-amber-500 text-gray-800 text-sm bg-amber-50"
            oninput="filterPickupDestSuggestions(this.value)"
            onblur="setTimeout(()=>document.getElementById('pickup-dest-suggestions').classList.add('hidden'),200)"/>
          <div id="pickup-dest-suggestions" class="hidden mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-20 max-h-40 overflow-y-auto"></div>
        </div>
        <!-- Return-to job site -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1.5">
            <i class="fas fa-hard-hat text-blue-500 mr-1"></i>Returning to which job site?
          </label>
          <input id="pickup-return-input" type="text" placeholder="e.g. 45 Main St (current job site)"
            autocomplete="off" maxlength="200"
            class="w-full px-4 py-3 border-2 border-blue-200 rounded-xl focus:outline-none focus:border-blue-500 text-gray-800 text-sm"
            oninput="filterPickupReturnSuggestions(this.value)"
            onblur="setTimeout(()=>document.getElementById('pickup-return-suggestions').classList.add('hidden'),200)"/>
          <div id="pickup-return-suggestions" class="hidden mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-20 max-h-40 overflow-y-auto"></div>
        </div>
        <!-- GPS Travel Time Estimate -->
        <div id="pickup-eta-card" class="hidden bg-blue-50 border border-blue-200 rounded-xl p-3">
          <p class="text-xs font-bold text-blue-800 mb-2"><i class="fas fa-route mr-1"></i>Estimated Trip Time</p>
          <div id="pickup-eta-content" class="text-xs text-blue-700 space-y-1"></div>
        </div>
      </div>

    </div>

    <!-- Sticky footer buttons — always visible -->
    <div class="flex-shrink-0 px-6 py-4 border-t border-gray-100 flex gap-3">
      <button onclick="closeJobModal()" class="flex-1 border-2 border-gray-200 text-gray-600 font-semibold py-3.5 rounded-xl hover:bg-gray-50">
        Cancel
      </button>
      <button onclick="confirmClockIn()" id="confirm-clock-in-btn"
        class="flex-2 flex-grow-[2] bg-green-500 hover:bg-green-600 text-white font-bold py-3.5 rounded-xl shadow-md clock-btn">
        <i class="fas fa-play-circle mr-2"></i>Start Working
      </button>
    </div>
  </div>
</div>

<!-- ── FRAUD BLOCKED MODAL ──────────────────────────────────────────────────── -->
<!-- ── Worker: Report Issue Modal ─────────────────────────────────────────── -->
<div id="dispute-modal" class="hidden fixed inset-0 bg-black/70 flex items-end justify-center" style="z-index:9990;padding:0 16px 88px">
  <div class="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl">
    <div class="flex items-center gap-3 mb-4">
      <div class="w-10 h-10 bg-rose-100 rounded-2xl flex items-center justify-center flex-shrink-0">
        <i class="fas fa-flag text-rose-500"></i>
      </div>
      <div>
        <h3 class="font-bold text-gray-800">Report an Issue</h3>
        <p id="dispute-session-label" class="text-xs text-gray-500"></p>
      </div>
    </div>
    <div class="bg-rose-50 border border-rose-200 rounded-xl p-3 mb-4 text-xs text-rose-700">
      <i class="fas fa-info-circle mr-1"></i>
      Your message will be sent to the admin for review. They can adjust your session if needed.
    </div>
    <textarea id="dispute-message" rows="3" placeholder="Describe the issue — e.g. 'I was clocked out by GPS but I was still on site'"
      class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 resize-none mb-3"></textarea>
    <div class="flex flex-wrap gap-1.5 mb-4">
      <button onclick="setDisputeMsg('GPS clocked me out but I was still on site')" class="text-xs bg-gray-100 text-gray-600 border px-2 py-1 rounded-lg hover:bg-gray-200">GPS error</button>
      <button onclick="setDisputeMsg('Wrong clock-out time — I worked longer')" class="text-xs bg-gray-100 text-gray-600 border px-2 py-1 rounded-lg hover:bg-gray-200">Wrong time</button>
      <button onclick="setDisputeMsg('Hours or earnings look incorrect')" class="text-xs bg-gray-100 text-gray-600 border px-2 py-1 rounded-lg hover:bg-gray-200">Wrong amount</button>
      <button onclick="setDisputeMsg('I forgot to clock in but was on site')" class="text-xs bg-gray-100 text-gray-600 border px-2 py-1 rounded-lg hover:bg-gray-200">Missed clock-in</button>
    </div>
    <div class="flex gap-3">
      <button onclick="closeDisputeModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl">Cancel</button>
      <button id="dispute-submit-btn" onclick="submitDispute()" class="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-3 rounded-xl">
        <i class="fas fa-paper-plane mr-1.5"></i>Send Report
      </button>
    </div>
  </div>
</div>

<div id="fraud-blocked-modal" class="hidden fixed inset-0 bg-black/70 flex items-end justify-center" style="z-index:9990;padding:0 16px 88px">
  <div class="bg-white rounded-3xl p-6 w-full max-w-md shadow-2xl">
    <!-- Header -->
    <div class="flex items-center gap-3 mb-4">
      <div class="w-12 h-12 bg-red-100 rounded-2xl flex items-center justify-center flex-shrink-0">
        <i class="fas fa-shield-alt text-red-500 text-xl"></i>
      </div>
      <div>
        <h3 class="text-lg font-bold text-gray-800">Location Mismatch</h3>
        <p class="text-xs text-red-500 font-medium">Clock-in Blocked</p>
      </div>
    </div>

    <!-- Map showing both points -->
    <div id="fraud-map" class="w-full h-48 rounded-2xl mb-4 bg-gray-100 overflow-hidden"></div>

    <!-- Distance info -->
    <div class="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
      <div class="flex items-start gap-3">
        <i class="fas fa-map-marker-alt text-red-500 mt-0.5"></i>
        <div>
          <p class="text-sm font-bold text-red-700 mb-1">You are too far from the job site</p>
          <p id="fraud-distance-msg" class="text-xs text-red-600 mb-2"></p>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="bg-white rounded-xl p-2 border border-red-100">
              <p class="text-gray-500 mb-0.5">📍 Your location</p>
              <p id="fraud-your-loc" class="font-medium text-gray-700 text-[11px] leading-snug"></p>
            </div>
            <div class="bg-white rounded-xl p-2 border border-red-100">
              <p class="text-gray-500 mb-0.5">🏗️ Job site</p>
              <p id="fraud-job-loc" class="font-medium text-gray-700 text-[11px] leading-snug"></p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Override request status -->
    <div id="fraud-override-section">
      <!-- Pending state -->
      <div id="fraud-pending" class="hidden bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center gap-3">
          <i class="fas fa-clock text-amber-500 text-lg animate-pulse"></i>
          <div>
            <p class="text-sm font-bold text-amber-700">Waiting for Admin Approval</p>
            <p class="text-xs text-amber-600 mt-0.5">Your override request has been sent to the admin. You will be clocked in as soon as they approve.</p>
            <p id="fraud-poll-status" class="text-xs text-amber-500 mt-1">Checking every 15 seconds...</p>
          </div>
        </div>
      </div>
      <!-- Request sent confirmation -->
      <div id="fraud-request-sent" class="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center gap-3">
          <i class="fas fa-paper-plane text-blue-500 text-lg"></i>
          <div>
            <p class="text-sm font-bold text-blue-700">Override Request Sent</p>
            <p class="text-xs text-blue-600 mt-0.5">Admin has been notified. Tap "Wait for Approval" to track the status.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Buttons -->
    <div class="flex flex-col gap-2">
      <button id="fraud-wait-btn" onclick="startOverridePolling()"
        class="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-3.5 rounded-2xl text-sm shadow-sm">
        <i class="fas fa-hourglass-half mr-2"></i>Wait for Admin Approval
      </button>
      <button onclick="closeFraudModal()"
        class="w-full border-2 border-gray-200 text-gray-600 font-semibold py-3 rounded-2xl text-sm hover:bg-gray-50">
        <i class="fas fa-times mr-2"></i>Cancel — Go Back
      </button>
    </div>
  </div>
</div>

<!-- Toast notification -->
<div id="toast" class="hidden fixed left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-5 py-3 rounded-xl shadow-xl text-sm font-medium max-w-xs text-center" style="bottom:88px;z-index:9999"></div>

<script src="/static/worker.js?v=20260305i"></script>
<!-- ── Worker Dispute Modal ─────────────────────────────────────────────────── -->
<div id="dispute-modal" class="hidden fixed inset-0 bg-black/70 flex items-end justify-center" style="z-index:9990;padding:0 16px 88px" onclick="if(event.target===this)closeDisputeModal()">
  <div class="bg-white w-full max-w-lg rounded-t-3xl shadow-2xl p-6 slide-up">
    <div class="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-5"></div>
    <div class="flex items-center gap-3 mb-4">
      <div class="w-11 h-11 bg-rose-100 rounded-2xl flex items-center justify-center flex-shrink-0">
        <i class="fas fa-flag text-rose-500 text-lg"></i>
      </div>
      <div>
        <h3 class="text-base font-bold text-gray-800">Report a Session Issue</h3>
        <p id="dispute-session-label" class="text-xs text-gray-500 mt-0.5"></p>
      </div>
    </div>
    <p class="text-xs text-gray-500 mb-3">
      Describe what happened — wrong clock-out time, GPS auto-clockout, missing hours, etc. Your admin will review and respond.
    </p>
    <textarea id="dispute-message" rows="4"
      placeholder="e.g. I was auto clocked out at 2pm but I worked until 4pm. My GPS lost signal."
      class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-rose-400 resize-none mb-3"></textarea>
    <div class="flex flex-wrap gap-2 mb-4">
      <button onclick="setDisputeMsg(1)" class="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full border border-gray-200">Auto clock-out error</button>
      <button onclick="setDisputeMsg(2)" class="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full border border-gray-200">Wrong end time</button>
      <button onclick="setDisputeMsg(3)" class="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full border border-gray-200">GPS error</button>
      <button onclick="setDisputeMsg(4)" class="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full border border-gray-200">Incorrect pay</button>
    </div>
    <div class="flex gap-3">
      <button onclick="closeDisputeModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl">Cancel</button>
      <button id="dispute-send-btn" onclick="sendDispute()" class="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold py-3 rounded-xl shadow-lg shadow-rose-200">
        <i class="fas fa-paper-plane mr-1.5"></i>Send Report
      </button>
    </div>
  </div>
</div>

<!-- PWA Install Banner -->
<div id="pwa-banner" style="display:none;position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#4f46e5;color:white;padding:14px 20px;align-items:center;gap:12px;box-shadow:0 -4px 20px rgba(0,0,0,0.3);">
  <img src="/static/icon-192.png" style="width:40px;height:40px;border-radius:10px;flex-shrink:0;"/>
  <div style="flex:1;">
    <div style="font-weight:700;font-size:14px;">Add ClockInProof to Home Screen</div>
    <div style="font-size:12px;opacity:0.85;">Tap Install — open anytime like a real app, no link needed</div>
  </div>
  <button id="pwa-install-btn" style="background:white;color:#4f46e5;border:none;padding:8px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;flex-shrink:0;">Install</button>
  <button onclick="document.getElementById('pwa-banner').style.display='none'" style="background:transparent;border:none;color:white;font-size:20px;cursor:pointer;padding:0 4px;flex-shrink:0;">✕</button>
</div>

<script>
// PWA: Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  });
}

// PWA: Android/Chrome install prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  setTimeout(() => {
    const banner = document.getElementById('pwa-banner');
    if (banner) banner.style.display = 'flex';
  }, 4000);
});

document.getElementById('pwa-install-btn')?.addEventListener('click', async () => {
  const banner = document.getElementById('pwa-banner');
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
  if (banner) banner.style.display = 'none';
});

// PWA: iOS Safari — show manual instructions
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isInStandalone = window.navigator.standalone === true;
if (isIOS && !isInStandalone) {
  setTimeout(() => {
    const banner = document.getElementById('pwa-banner');
    const btn = document.getElementById('pwa-install-btn');
    if (banner && btn) {
      banner.style.display = 'flex';
      btn.textContent = 'How to Install';
      btn.onclick = () => {
        console.log('iOS install hint shown');
      };
    }
  }, 4000);
}
</script>

</body>
</html>`
}

// ─────────────────────────────────────────────────────────────────────────────
function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>ClockInProof — Admin Dashboard</title>
  <link rel="icon" type="image/png" href="/static/icon-192.png"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    /* ── THEME VARIABLES ─────────────────────────────────────────────────── */
    :root {
      --bg-base:     #f1f5f9;
      --bg-card:     #ffffff;
      --bg-sidebar:  #ffffff;
      --bg-input:    #f8fafc;
      --border:      #e2e8f0;
      --text-primary:#1e293b;
      --text-secondary:#64748b;
      --text-muted:  #94a3b8;
      --tab-active-bg:#eef2ff;
      --tab-active-text:#4338ca;
      --row-hover:   #f8fafc;
      --shadow:      0 1px 4px rgba(0,0,0,.07);
    }
    html.dark {
      --bg-base:     #0f172a;
      --bg-card:     #1e293b;
      --bg-sidebar:  #1e293b;
      --bg-input:    #0f172a;
      --border:      #334155;
      --text-primary:#f1f5f9;
      --text-secondary:#94a3b8;
      --text-muted:  #64748b;
      --tab-active-bg:#1e3a5f;
      --tab-active-text:#93c5fd;
      --row-hover:   #273548;
      --shadow:      0 1px 4px rgba(0,0,0,.35);
    }
    /* ── APPLY THEME VARS ────────────────────────────────────────────────── */
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg-base) !important; color: var(--text-primary) !important; transition: background 0.2s, color 0.2s; }
    /* Cards / panels */
    .bg-white, [class*="bg-white"]                          { background: var(--bg-card) !important; }
    .bg-gray-50                                             { background: var(--bg-input) !important; }
    .bg-gray-100, .min-h-screen.bg-gray-100                { background: var(--bg-base) !important; }
    .bg-gray-200                                            { background: var(--border) !important; }
    /* Borders */
    .border-gray-200, .border-gray-100                      { border-color: var(--border) !important; }
    /* Text */
    .text-gray-800, .text-gray-900                         { color: var(--text-primary) !important; }
    .text-gray-600, .text-gray-700                         { color: var(--text-secondary) !important; }
    .text-gray-400, .text-gray-500                         { color: var(--text-muted) !important; }
    /* Sidebar */
    aside, #admin-sidebar                                   { background: var(--bg-sidebar) !important; border-color: var(--border) !important; }
    /* Inputs */
    input, select, textarea                                 { background: var(--bg-input) !important; color: var(--text-primary) !important; border-color: var(--border) !important; }
    /* Table rows */
    tr:hover td                                             { background: var(--row-hover) !important; }
    th                                                      { background: var(--bg-input) !important; color: var(--text-secondary) !important; border-color: var(--border) !important; }
    td                                                      { border-color: var(--border) !important; }
    /* Tab active */
    .tab-active                                             { background-color: var(--tab-active-bg) !important; color: var(--tab-active-text) !important; }
    /* Modals */
    .modal-content, [id$="-modal"] > div                   { background: var(--bg-card) !important; }
    /* Theme toggle button */
    #admin-theme-toggle { transition: all 0.2s; }

    body { font-family: 'Segoe UI', system-ui, sans-serif; }
    #admin-map { height: 400px; }
    .tab-active { background-color: #eef2ff; color: #4338ca; font-weight: 600; }
    .tab-active .w-8 { background-color: #4338ca !important; color: white !important; }
    .sidebar-btn { border: none; text-align: left; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
    .spinner { animation: spin 1s linear infinite; }
    @keyframes spin { to{transform:rotate(360deg)} }
  </style>
  <script>
    // Init theme immediately to avoid flash
    (function(){
      const saved = localStorage.getItem('cip_theme');
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (saved === 'dark' || (!saved && sysDark)) document.documentElement.classList.add('dark');
    })();
  </script>
</head>
<body class="bg-gray-100 min-h-screen">

<!-- Admin Login -->
<div id="admin-login" class="min-h-screen flex items-center justify-center p-4" style="background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)">
  <div class="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm">
    <div class="text-center mb-6">
      <div class="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
        <i class="fas fa-clock text-white text-2xl"></i>
      </div>
      <h2 class="text-2xl font-bold text-gray-800">Admin Dashboard</h2>
      <p class="text-gray-500 text-sm mt-1">Sign in to your ClockInProof account</p>
    </div>
    <div class="space-y-3">
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1">Admin Email</label>
        <input id="admin-email-input" type="email" placeholder="admin@yourcompany.com"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-600 mb-1">Admin PIN</label>
        <input id="admin-pin-input" type="password" placeholder="Enter your PIN" maxlength="8"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
      </div>
      <button onclick="adminLogin()"
        class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl transition-colors mt-1">
        <i class="fas fa-unlock mr-2"></i>Access Dashboard
      </button>
    </div>
    <div id="admin-login-error" class="hidden mt-3 text-red-500 text-sm text-center bg-red-50 rounded-lg p-2"></div>
    <div class="mt-5 pt-4 border-t border-gray-100 text-center">
      <p class="text-xs text-gray-400">Your email and PIN were set during company signup</p>
      <a href="mailto:support@clockinproof.com" class="text-xs text-indigo-500 hover:underline mt-1 inline-block">Need help? Contact support</a>
    </div>
    <div class="mt-4 text-center">
      <p class="text-[10px] text-gray-300">Powered by <span class="font-bold text-gray-400">ClockInProof</span></p>
    </div>
  </div>
</div>

<!-- Admin Dashboard -->
<div id="admin-dashboard" class="hidden min-h-screen bg-gray-100 flex flex-col">

  <!-- ── Top Navbar ─────────────────────────────────────────────────────────── -->
  <div class="bg-indigo-700 text-white shadow-lg flex-shrink-0">
    <div class="px-4 py-3 flex items-center justify-between">
      <!-- Left: hamburger + tenant brand -->
      <div class="flex items-center gap-3">
        <button onclick="toggleSidebar()" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-indigo-600 transition-colors lg:hidden" id="sidebar-hamburger">
          <i class="fas fa-bars text-lg"></i>
        </button>
        <!-- Tenant brand block — swapped in by applyTenantBranding() -->
        <div class="flex items-center gap-2.5" id="navbar-brand">
          <!-- Tenant logo (shown when logo set) -->
          <div id="navbar-logo-wrap" class="w-8 h-8 rounded-lg overflow-hidden bg-white bg-opacity-20 flex items-center justify-center flex-shrink-0 hidden">
            <img id="navbar-logo-img" src="" alt="" class="w-full h-full object-contain" />
          </div>
          <!-- Fallback clock icon (shown when no logo) -->
          <div id="navbar-logo-fallback" class="w-8 h-8 bg-white bg-opacity-20 rounded-lg flex items-center justify-center flex-shrink-0">
            <i class="fas fa-clock text-sm"></i>
          </div>
          <div>
            <h1 class="text-base font-bold leading-tight" id="navbar-company-name">ClockInProof</h1>
            <p class="text-indigo-300 text-[10px] leading-tight" id="admin-last-updated"></p>
          </div>
        </div>
      </div>
      <!-- Right: stat pills + "Powered by" badge + actions -->
      <div class="flex items-center gap-2">
        <!-- Mini stat pills (always visible) -->
        <div class="hidden sm:flex items-center gap-2">
          <div onclick="showTab('live')" class="flex items-center gap-1.5 bg-green-500 bg-opacity-30 hover:bg-opacity-50 cursor-pointer px-3 py-1.5 rounded-full transition-colors">
            <span class="w-2 h-2 bg-green-400 rounded-full pulse"></span>
            <span class="text-xs font-bold" id="stat-working-now">–</span>
            <span class="text-xs text-indigo-200">live</span>
          </div>
          <div onclick="showTab('payroll')" class="flex items-center gap-1.5 bg-white bg-opacity-10 hover:bg-opacity-20 cursor-pointer px-3 py-1.5 rounded-full transition-colors">
            <i class="fas fa-dollar-sign text-indigo-200 text-xs"></i>
            <span class="text-xs font-bold" id="stat-total-payroll">–</span>
          </div>
          <div onclick="showTab('sessions')" class="flex items-center gap-1.5 bg-white bg-opacity-10 hover:bg-opacity-20 cursor-pointer px-3 py-1.5 rounded-full transition-colors">
            <i class="fas fa-clock text-indigo-200 text-xs"></i>
            <span class="text-xs font-bold" id="stat-total-hours">–</span>
            <span class="text-xs text-indigo-200">hrs</span>
          </div>
        </div>
        <!-- Powered by ClockInProof badge -->
        <div class="hidden md:flex items-center gap-1.5 bg-white bg-opacity-10 border border-white border-opacity-20 rounded-lg px-2.5 py-1" id="powered-by-badge">
          <i class="fas fa-clock text-indigo-300 text-[10px]"></i>
          <span class="text-[10px] text-indigo-200 font-medium whitespace-nowrap">Powered by <span class="text-white font-bold">ClockInProof</span></span>
        </div>
        <!-- Period selector compact -->
        <select onchange="changePeriod(this.value)" id="period-select" class="hidden sm:block bg-indigo-600 border border-indigo-500 text-white text-xs rounded-xl px-2 py-1.5 focus:outline-none">
          <option value="today">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="all">All Time</option>
        </select>
        <button onclick="refreshAll()" class="w-9 h-9 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors">
          <i class="fas fa-sync-alt text-sm"></i>
        </button>
        <button id="admin-theme-toggle" onclick="toggleTheme()" title="Toggle dark/light mode" class="w-9 h-9 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 rounded-xl transition-colors">
          <i id="admin-theme-icon" class="fas fa-moon text-sm"></i>
        </button>
        <button onclick="adminLogout()" class="w-9 h-9 flex items-center justify-center bg-indigo-800 hover:bg-indigo-900 rounded-xl transition-colors">
          <i class="fas fa-sign-out-alt text-sm"></i>
        </button>
      </div>
    </div>
  </div>

  <!-- ── Body: sidebar + content ────────────────────────────────────────────── -->
  <div class="flex flex-1 overflow-hidden relative">

    <!-- ── Sidebar ─────────────────────────────────────────────────────────── -->
    <aside id="admin-sidebar" class="w-64 bg-white border-r border-gray-200 flex-shrink-0 flex flex-col shadow-sm
      fixed lg:static inset-y-0 left-0 z-40 transform -translate-x-full lg:translate-x-0 transition-transform duration-200"
      style="top:56px;height:calc(100vh - 56px)">

      <!-- Sidebar scroll area -->
      <nav class="flex-1 overflow-y-auto py-4 px-3 space-y-1">

        <!-- OVERVIEW -->
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 mt-1">Overview</p>

        <button onclick="showTab('live')" data-tab="live"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors tab-active">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-100 text-green-600 flex-shrink-0">
            <i class="fas fa-satellite-dish text-sm"></i>
          </span>
          <span>Live View</span>
          <span id="live-count-badge" class="ml-auto bg-green-100 text-green-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full hidden">0</span>
        </button>

        <button onclick="showTab('sessions')" data-tab="sessions"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-blue-100 text-blue-600 flex-shrink-0">
            <i class="fas fa-list text-sm"></i>
          </span>
          <span>Sessions</span>
        </button>

        <button onclick="showTab('map')" data-tab="map"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-teal-100 text-teal-600 flex-shrink-0">
            <i class="fas fa-map text-sm"></i>
          </span>
          <span>Map</span>
        </button>

        <button onclick="showTab('calendar')" data-tab="calendar"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 flex-shrink-0">
            <i class="fas fa-calendar-alt text-sm"></i>
          </span>
          <span>Calendar</span>
        </button>

        <!-- WORKFORCE -->
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 mt-5">Workforce</p>

        <!-- Workforce accordion button -->
        <button id="workforce-btn"
          onclick="toggleWorkforce(event)"
          type="button"
          class="tab-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors"
          data-tab="workers">
          <span id="workforce-icon" class="w-8 h-8 flex items-center justify-center rounded-lg bg-blue-100 text-blue-600 flex-shrink-0">
            <i class="fas fa-users text-sm"></i>
          </span>
          <span>Workforce</span>
          <span class="ml-auto flex items-center gap-1.5">
            <span class="text-xs text-gray-400" id="stat-total-workers">–</span>
            <i id="workforce-chevron" class="fas fa-chevron-down text-[10px] text-gray-400 transition-transform duration-200"></i>
          </span>
        </button>

        <!-- Workforce sub-menu (hidden by default, toggled by JS) -->
        <div id="workers-submenu" class="hidden ml-2 mt-0.5 pl-3 border-l-2 border-blue-100 space-y-0.5">

          <button type="button" id="wv-onsite"
            onclick="doShowWorkersView('onsite')"
            class="wv-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-gray-600 hover:bg-green-50 hover:text-green-700 transition-colors">
            <span class="w-6 h-6 flex items-center justify-center rounded-md bg-green-100 text-green-600 flex-shrink-0">
              <i class="fas fa-hard-hat text-[10px]"></i>
            </span>
            <span>Onsite Now</span>
            <span id="onsite-count-badge" class="ml-auto bg-green-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full hidden">0</span>
          </button>

          <button type="button" id="wv-active"
            onclick="doShowWorkersView('active')"
            class="wv-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-gray-600 hover:bg-blue-50 hover:text-blue-700 transition-colors">
            <span class="w-6 h-6 flex items-center justify-center rounded-md bg-blue-100 text-blue-600 flex-shrink-0">
              <i class="fas fa-user-check text-[10px]"></i>
            </span>
            <span>Active</span>
          </button>

          <button type="button" id="wv-all"
            onclick="doShowWorkersView('all')"
            class="wv-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors">
            <span class="w-6 h-6 flex items-center justify-center rounded-md bg-gray-100 text-gray-500 flex-shrink-0">
              <i class="fas fa-list text-[10px]"></i>
            </span>
            <span>All Workers</span>
            <span class="ml-auto text-xs text-gray-400" id="stat-total-workers-badge"></span>
          </button>

        </div>

        <button onclick="showTab('overrides')" data-tab="overrides"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors relative">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-red-100 text-red-500 flex-shrink-0">
            <i class="fas fa-shield-alt text-sm"></i>
          </span>
          <span>Overrides</span>
          <span id="override-badge" class="hidden ml-auto bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">0</span>
        </button>

        <!-- FINANCE -->
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 mt-5">Finance</p>

        <button onclick="showTab('payroll')" data-tab="payroll"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-purple-100 text-purple-600 flex-shrink-0">
            <i class="fas fa-dollar-sign text-sm"></i>
          </span>
          <span>Payroll Totals</span>
        </button>

        <button onclick="showTab('export')" data-tab="export"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-100 text-green-600 flex-shrink-0">
            <i class="fas fa-file-export text-sm"></i>
          </span>
          <span>Export Timesheet</span>
        </button>

        <button onclick="showTab('accountant')" data-tab="accountant"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-amber-100 text-amber-600 flex-shrink-0">
            <i class="fas fa-file-invoice-dollar text-sm"></i>
          </span>
          <span>Payroll Export</span>
          <span class="ml-auto text-[10px] text-green-700 font-bold bg-green-50 px-1.5 py-0.5 rounded-full">QB</span>
        </button>

        <button onclick="showTab('quickbooks')" data-tab="quickbooks"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-100 text-green-700 flex-shrink-0">
            <i class="fas fa-plug text-sm"></i>
          </span>
          <span>QuickBooks Sync</span>
          <span id="qb-nav-badge" class="ml-auto text-[10px] text-white font-bold bg-gray-400 px-1.5 py-0.5 rounded-full hidden">●</span>
        </button>

        <!-- ADMIN -->
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-2 mt-5">Admin</p>

        <button onclick="showTab('job-sites')" data-tab="job-sites"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 flex-shrink-0">
            <i class="fas fa-map-marker-alt text-sm"></i>
          </span>
          <span>Job Sites</span>
        </button>

        <button onclick="showTab('dispatch')" data-tab="dispatch"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-violet-100 text-violet-600 flex-shrink-0">
            <i class="fas fa-paper-plane text-sm"></i>
          </span>
          <span>Dispatch</span>
          <span id="dispatch-badge" class="hidden ml-auto bg-violet-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"></span>
        </button>

        <button onclick="showTab('encircle')" data-tab="encircle"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-sky-100 text-sky-600 flex-shrink-0">
            <i class="fas fa-sync-alt text-sm"></i>
          </span>
          <span>Encircle</span>
          <span id="encircle-badge" class="hidden ml-auto bg-sky-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"></span>
        </button>

        <button onclick="showTab('disputes')" data-tab="disputes"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-rose-100 text-rose-600 flex-shrink-0">
            <i class="fas fa-flag text-sm"></i>
          </span>
          <span>Issue Reports</span>
          <span id="disputes-badge" class="hidden ml-auto bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"></span>
        </button>

        <button onclick="showTab('support-tickets')" data-tab="support-tickets"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 flex-shrink-0">
            <i class="fas fa-life-ring text-sm"></i>
          </span>
          <span>Support</span>
          <span id="tenant-tickets-badge" class="hidden ml-auto bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"></span>
        </button>

        <button onclick="showTab('settings')" data-tab="settings"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 flex-shrink-0">
            <i class="fas fa-building text-sm"></i>
          </span>
          <span>Company Settings</span>
        </button>

      </nav>

      <!-- Sidebar footer -->
      <div class="border-t px-4 py-3 bg-gray-50">
        <a href="mailto:support@clockinproof.com" class="flex items-center gap-2 text-xs text-gray-500 hover:text-indigo-600 transition mb-3">
          <i class="fas fa-life-ring"></i>
          <span>support@clockinproof.com</span>
        </a>
        <div class="flex gap-2">
          <button onclick="changePeriod('today')" data-period="today" class="period-btn flex-1 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium">Today</button>
          <button onclick="changePeriod('week')" data-period="week" class="period-btn flex-1 py-1.5 text-xs rounded-lg bg-white border text-gray-600 font-medium">Week</button>
          <button onclick="changePeriod('month')" data-period="month" class="period-btn flex-1 py-1.5 text-xs rounded-lg bg-white border text-gray-600 font-medium">Month</button>
          <button onclick="changePeriod('all')" data-period="all" class="period-btn flex-1 py-1.5 text-xs rounded-lg bg-white border text-gray-600 font-medium">All</button>
        </div>
      </div>
    </aside>

    <!-- Sidebar overlay for mobile -->
    <div id="sidebar-overlay" class="hidden fixed inset-0 bg-black bg-opacity-40 z-30 lg:hidden" onclick="toggleSidebar()"></div>

    <!-- ── Main content area ──────────────────────────────────────────────── -->
    <main class="flex-1 overflow-y-auto p-4 lg:p-6 min-w-0">

      <!-- Stats row (top of content, always visible) -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div onclick="showTab('workers')" class="bg-white rounded-2xl shadow-sm p-4 cursor-pointer hover:shadow-md hover:ring-2 hover:ring-blue-200 transition-all group">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center group-hover:bg-blue-200 transition-colors flex-shrink-0">
              <i class="fas fa-users text-blue-600 text-xs"></i>
            </div>
            <span class="text-gray-400 text-xs">Workers</span>
          </div>
          <p class="text-2xl font-bold text-gray-800" id="stat-total-workers-card">–</p>
        </div>
        <div onclick="showTab('live')" class="bg-white rounded-2xl shadow-sm p-4 cursor-pointer hover:shadow-md hover:ring-2 hover:ring-green-200 transition-all group">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors flex-shrink-0">
              <i class="fas fa-user-clock text-green-600 text-xs"></i>
            </div>
            <span class="text-gray-400 text-xs">Working Now</span>
          </div>
          <p class="text-2xl font-bold text-green-600" id="stat-working-now-card">–</p>
        </div>
        <div onclick="showTab('sessions')" class="bg-white rounded-2xl shadow-sm p-4 cursor-pointer hover:shadow-md hover:ring-2 hover:ring-yellow-200 transition-all group">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 bg-yellow-100 rounded-lg flex items-center justify-center group-hover:bg-yellow-200 transition-colors flex-shrink-0">
              <i class="fas fa-clock text-yellow-600 text-xs"></i>
            </div>
            <span class="text-gray-400 text-xs">Total Hours</span>
          </div>
          <p class="text-2xl font-bold text-gray-800" id="stat-total-hours-card">–</p>
        </div>
        <div onclick="showTab('payroll')" class="bg-white rounded-2xl shadow-sm p-4 cursor-pointer hover:shadow-md hover:ring-2 hover:ring-purple-200 transition-all group">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center group-hover:bg-purple-200 transition-colors flex-shrink-0">
              <i class="fas fa-dollar-sign text-purple-600 text-xs"></i>
            </div>
            <span class="text-gray-400 text-xs">Payroll</span>
          </div>
          <p class="text-2xl font-bold text-gray-800" id="stat-total-payroll-card">–</p>
        </div>
      </div>

    <!-- Tab: Live -->
    <div id="tab-live" class="tab-content bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 class="font-bold text-gray-700 flex items-center gap-2">
          <span class="w-2 h-2 bg-green-500 rounded-full pulse"></span>
          Currently Working Workers
        </h3>
        <div class="flex items-center gap-2 flex-wrap">
          <button onclick="showBulkClockoutModal()" id="bulk-clockout-btn"
            class="hidden bg-orange-100 hover:bg-orange-200 text-orange-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors flex items-center gap-1.5">
            <i class="fas fa-map-marker-slash"></i>
            <span id="bulk-clockout-label">Clock Out All — Left Site</span>
          </button>
          <button onclick="loadLive()" class="text-gray-400 hover:text-gray-600 text-xs px-3 py-2 rounded-xl hover:bg-gray-100 transition-colors">
            <i class="fas fa-sync-alt mr-1"></i>Refresh
          </button>
        </div>
      </div>
      <div id="live-workers" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <p class="text-gray-400 text-center py-8 col-span-full">No workers currently clocked in</p>
      </div>
    </div>

    <!-- Tab: Workers -->
    <div id="tab-workers" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <!-- Header row -->
      <div class="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 class="font-bold text-gray-700" id="workers-tab-title">All Workers</h3>
          <p class="text-xs text-gray-400" id="workers-tab-subtitle">Everyone on the team</p>
        </div>
        <button onclick="showAddWorkerModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2 rounded-xl font-medium">
          <i class="fas fa-plus mr-1"></i>Add Worker
        </button>
      </div>

      <!-- Device Reset Requests Alert Banner -->
      <div id="device-reset-banner" class="mb-4 hidden">
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <i class="fas fa-mobile-alt text-amber-500"></i>
              <span class="text-sm font-bold text-amber-800">New Phone Requests</span>
              <span id="device-reset-badge" class="hidden bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">0</span>
            </div>
            <button onclick="loadDeviceResetRequests()" class="text-xs text-amber-600 hover:text-amber-800 font-semibold">
              <i class="fas fa-rotate-right text-xs mr-1"></i>Refresh
            </button>
          </div>
          <div id="device-reset-list">
            <p class="text-xs text-gray-400 text-center py-2">Loading...</p>
          </div>
        </div>
      </div>
      <!-- Status filter pills — shown only in 'all' and 'active' views -->
      <div class="flex flex-wrap gap-2 mb-4" id="workers-filter-bar">
        <button onclick="setWorkerFilter('all')" id="wf-all"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-indigo-500 bg-indigo-50 text-indigo-700 font-semibold transition-all">
          <i class="fas fa-users mr-1"></i>All
        </button>
        <button onclick="setWorkerFilter('active')" id="wf-active"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-green-400 hover:bg-green-50 transition-all">
          <i class="fas fa-check-circle mr-1"></i>Active
        </button>
        <button onclick="setWorkerFilter('on_holiday')" id="wf-on_holiday"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-blue-400 hover:bg-blue-50 transition-all">
          <i class="fas fa-umbrella-beach mr-1"></i>On Holiday
        </button>
        <button onclick="setWorkerFilter('sick_leave')" id="wf-sick_leave"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-yellow-400 hover:bg-yellow-50 transition-all">
          <i class="fas fa-thermometer-half mr-1"></i>Sick Leave
        </button>
        <button onclick="setWorkerFilter('suspended')" id="wf-suspended"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-orange-400 hover:bg-orange-50 transition-all">
          <i class="fas fa-pause-circle mr-1"></i>Suspended
        </button>
        <button onclick="setWorkerFilter('terminated')" id="wf-terminated"
          class="text-xs px-3 py-1.5 rounded-full border-2 border-transparent bg-gray-100 text-gray-600 font-medium hover:border-red-400 hover:bg-red-50 transition-all">
          <i class="fas fa-user-slash mr-1"></i>Terminated
        </button>
        <span id="workers-count" class="ml-auto text-xs text-gray-400 self-center"></span>
      </div>
      <div id="workers-table" class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="border-b text-gray-500">
            <th class="py-3 text-left">Name</th>
            <th class="py-3 text-left">Phone</th>
            <th class="py-3 text-right">Rate/hr</th>
            <th class="py-3 text-right">Total Hrs</th>
            <th class="py-3 text-right">Total Earned</th>
            <th class="py-3 text-center">Status</th>
            <th class="py-3 text-center">Link</th>
            <th class="py-3"></th>
          </tr></thead>
          <tbody id="workers-tbody">
            <tr><td colspan="8" class="text-center py-8 text-gray-400">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Sessions -->
    <div id="tab-sessions" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h3 class="font-bold text-gray-700">Work Sessions</h3>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="date" id="filter-date" class="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            onchange="loadSessions()"/>
          <select id="filter-worker" class="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" onchange="loadSessions()">
            <option value="">All Workers</option>
          </select>
          <button onclick="exportCSV()" class="bg-green-600 hover:bg-green-700 text-white text-sm px-4 py-2 rounded-xl font-medium">
            <i class="fas fa-download mr-1"></i>Export
          </button>
        </div>
      </div>
      <!-- Day-grouped sessions view -->
      <div id="sessions-by-day" class="space-y-5"></div>
    </div>

    <!-- Tab: Map -->
    <div id="tab-map" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="font-bold text-gray-700 flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse"></span>
            <span id="map-live-label">Live — Currently Onsite</span>
          </h3>
          <p class="text-xs text-gray-400 mt-0.5">Only workers currently clocked in are shown</p>
        </div>
        <button onclick="loadMap()" class="text-indigo-600 text-sm font-medium hover:text-indigo-700 flex items-center gap-1">
          <i class="fas fa-sync-alt"></i> Refresh
        </button>
      </div>
      <div id="admin-map" class="rounded-xl overflow-hidden"></div>
    </div>

    <!-- Tab: Calendar -->
    <div id="tab-calendar" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h3 class="font-bold text-gray-700 flex items-center gap-2">
          <i class="fas fa-calendar-alt text-indigo-500"></i> Work Calendar
        </h3>
        <div class="flex items-center gap-2 flex-wrap">
          <select id="cal-worker-filter" class="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" onchange="loadCalendar()">
            <option value="">All Workers</option>
          </select>
          <button onclick="calPrevMonth()" class="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-xl flex items-center justify-center">
            <i class="fas fa-chevron-left text-sm"></i>
          </button>
          <span id="cal-month-label" class="font-bold text-gray-800 min-w-[140px] text-center text-sm"></span>
          <button onclick="calNextMonth()" class="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-xl flex items-center justify-center">
            <i class="fas fa-chevron-right text-sm"></i>
          </button>
          <button onclick="calGoToday()" class="px-3 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded-xl text-sm font-medium">Today</button>
        </div>
      </div>

      <!-- Legend -->
      <div class="flex flex-wrap gap-3 mb-4 text-xs">
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-green-100 border border-green-300 inline-block"></span> Worked</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-red-100 border border-red-300 inline-block"></span> Stat Holiday</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-gray-100 border border-gray-300 inline-block"></span> Weekend</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-blue-50 border border-blue-200 inline-block"></span> Workday (no session)</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-yellow-100 border border-yellow-300 inline-block"></span> Today</span>
      </div>

      <!-- Calendar Grid -->
      <div id="cal-grid" class="overflow-x-auto">
        <div class="min-w-[600px]">
          <!-- Day headers -->
          <div class="grid grid-cols-7 mb-1">
            <div class="text-center text-xs font-bold text-gray-500 py-2">Sun</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Mon</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Tue</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Wed</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Thu</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Fri</div>
            <div class="text-center text-xs font-bold text-gray-500 py-2">Sat</div>
          </div>
          <div id="cal-days" class="grid grid-cols-7 gap-1"></div>
        </div>
      </div>

      <!-- Monthly Summary -->
      <div id="cal-summary" class="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3"></div>

      <!-- Holiday List -->
      <div id="cal-holidays" class="mt-4"></div>
    </div>

    <!-- Tab: Settings -->
    <div id="tab-settings" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">

      <!-- ── Tenant Brand Header ── -->
      <div id="settings-tenant-header" class="flex items-center gap-4 mb-6 pb-5 border-b border-gray-100">
        <!-- Logo -->
        <div id="settings-logo-wrap" class="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0 overflow-hidden">
          <img id="settings-logo-img" src="" alt="" class="w-full h-full object-contain hidden" />
          <i id="settings-logo-icon" class="fas fa-building text-indigo-400 text-xl"></i>
        </div>
        <!-- Name + contact info -->
        <div class="flex-1 min-w-0">
          <h3 id="settings-company-title" class="text-xl font-bold text-gray-900 leading-tight truncate">Loading…</h3>
          <!-- Address -->
          <p id="settings-company-address" class="text-xs text-gray-500 mt-0.5 truncate hidden">
            <i class="fas fa-map-marker-alt text-gray-400 mr-1"></i>
            <span id="settings-company-address-text"></span>
          </p>
          <!-- Phone -->
          <p id="settings-company-phone" class="text-xs text-gray-500 mt-0.5 hidden">
            <i class="fas fa-phone text-gray-400 mr-1"></i>
            <span id="settings-company-phone-text"></span>
          </p>
          <!-- Worker app URL -->
          <a id="settings-worker-url" href="#" target="_blank"
             class="inline-flex items-center gap-1.5 text-xs text-indigo-500 hover:text-indigo-700 font-medium mt-1 hover:underline">
            <i class="fas fa-mobile-alt"></i>
            <span id="settings-worker-url-text">app.clockinproof.com</span>
          </a>
        </div>
        <!-- Settings gear label -->
        <div class="flex-shrink-0 text-right hidden sm:block">
          <span class="inline-flex items-center gap-1.5 text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-full px-3 py-1.5">
            <i class="fas fa-cog text-gray-400"></i> App Settings
          </span>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">

        <!-- General -->
        <div class="space-y-4">
          <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2">General</h4>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input id="s-app-name" type="text" placeholder="e.g. 911 Restoration of Ottawa" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Shown on the worker app and all outbound communications.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Company Logo</label>
            <!-- Upload zone -->
            <div id="logo-upload-zone"
              class="relative border-2 border-dashed border-indigo-200 rounded-2xl bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-400 transition-colors cursor-pointer"
              onclick="document.getElementById('logo-file-input').click()"
              ondragover="event.preventDefault();this.classList.add('border-indigo-500','bg-indigo-100')"
              ondragleave="this.classList.remove('border-indigo-500','bg-indigo-100')"
              ondrop="handleLogoDrop(event)">
              <input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/svg+xml,image/webp" class="hidden" onchange="handleLogoFileSelect(event)" />
              <!-- Preview state (hidden until image loaded) -->
              <div id="logo-preview-state" class="hidden flex flex-col items-center py-3 px-4 gap-2">
                <img id="logo-preview-img" src="" alt="Logo preview" class="max-h-16 max-w-full object-contain rounded-lg shadow-sm" />
                <div class="flex items-center gap-2">
                  <span class="text-xs text-green-600 font-medium"><i class="fas fa-check-circle mr-1"></i>Logo ready</span>
                  <button type="button" onclick="event.stopPropagation();clearLogoUpload()" class="text-xs text-red-400 hover:text-red-600"><i class="fas fa-times mr-1"></i>Remove</button>
                </div>
              </div>
              <!-- Empty state -->
              <div id="logo-empty-state" class="flex flex-col items-center py-5 px-4 gap-2">
                <div class="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center">
                  <i class="fas fa-cloud-upload-alt text-indigo-400 text-xl"></i>
                </div>
                <div class="text-center">
                  <p class="text-sm font-medium text-indigo-700">Click or drag image here</p>
                  <p class="text-xs text-gray-400 mt-0.5">PNG, JPG, SVG or WebP · Max 500KB</p>
                </div>
              </div>
            </div>
            <!-- Hidden field to store the final value (base64 or URL) -->
            <input type="hidden" id="s-logo-url" />
            <p class="text-xs text-gray-400 mt-2"><i class="fas fa-info-circle mr-1"></i>Shown in the top bar and sidebar of this dashboard.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Worker App URL</label>
            <div class="flex items-center gap-2 px-3 py-2.5 border border-gray-200 rounded-xl bg-gray-50">
              <i class="fas fa-mobile-alt text-gray-400 text-sm"></i>
              <span id="s-worker-app-url-display" class="text-sm text-gray-600 font-mono flex-1">—</span>
              <button onclick="navigator.clipboard.writeText(document.getElementById('s-worker-app-url-display').textContent).then(()=>showAdminToast('URL copied!','success',2000))"
                class="text-xs text-indigo-500 hover:text-indigo-700 font-medium">
                <i class="fas fa-copy"></i>
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Share this link with your workers to clock in.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Company Address</label>
            <input id="s-company-address" type="text" placeholder="e.g. 11 Trustan Court #4, Ottawa, Ontario K2E 8B9"
              class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Appears on payroll exports, reports, and worker communications.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Company Phone</label>
            <input id="s-company-phone" type="tel" placeholder="e.g. +1 613-218-9339"
              class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Used for dispatched job SMS messages and worker-facing contacts.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Default Hourly Rate ($/hr)</label>
            <input id="s-hourly-rate" type="number" step="0.50" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Admin PIN</label>
            <input id="s-admin-pin" type="text" maxlength="6" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Admin Email <span class="text-xs text-indigo-600 font-normal">(weekly reports sent here)</span>
            </label>
            <input id="s-admin-email" type="email" placeholder="admin@example.com"
              class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Reports auto-emailed every Friday night when Resend key is set</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Reply-To Email <span class="text-xs text-indigo-600 font-normal">(your real inbox — tenants reply here)</span>
            </label>
            <input id="s-reply-to-email" type="email" placeholder="Noweis2020@gmail.com"
              class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">All outbound emails (alerts, reports, payroll) will have this as reply-to. Keeps your Google Workspace inbox intact.</p>
          </div>
        </div>

        <!-- Jurisdiction -->
        <div class="space-y-4">
          <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2">Location & Holidays</h4>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select id="s-country" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm" onchange="updateProvinceList()">
              <option value="CA">🇨🇦 Canada</option>
              <option value="US">🇺🇸 United States</option>
              <option value="GB">🇬🇧 United Kingdom</option>
              <option value="AU">🇦🇺 Australia</option>
              <option value="NZ">🇳🇿 New Zealand</option>
              <option value="DE">🇩🇪 Germany</option>
              <option value="FR">🇫🇷 France</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Province / State</label>
            <select id="s-province" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"></select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">City (for reference)</label>
            <input id="s-city" type="text" placeholder="e.g. Toronto" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
            <select id="s-timezone" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm">
              <option value="America/Toronto">America/Toronto (ET)</option>
              <option value="America/Vancouver">America/Vancouver (PT)</option>
              <option value="America/Edmonton">America/Edmonton (MT)</option>
              <option value="America/Winnipeg">America/Winnipeg (CT)</option>
              <option value="America/Halifax">America/Halifax (AT)</option>
              <option value="America/St_Johns">America/St_Johns (NT)</option>
              <option value="America/New_York">America/New_York (EST)</option>
              <option value="America/Chicago">America/Chicago (CST)</option>
              <option value="America/Denver">America/Denver (MST)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
              <option value="Europe/London">Europe/London (GMT)</option>
              <option value="Australia/Sydney">Australia/Sydney (AEST)</option>
              <option value="UTC">UTC</option>
            </select>
          </div>
        </div>

        <!-- Work Schedule -->
        <div class="space-y-4">
          <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2">Work Schedule</h4>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
              <input id="s-work-start" type="time" value="08:00" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">End Time</label>
              <input id="s-work-end" type="time" value="16:00" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Work Days</label>
            <div class="flex gap-1 flex-wrap" id="s-work-days">
              <button type="button" onclick="toggleDay(0)" data-day="0" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50">Sun</button>
              <button type="button" onclick="toggleDay(1)" data-day="1" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white">Mon</button>
              <button type="button" onclick="toggleDay(2)" data-day="2" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white">Tue</button>
              <button type="button" onclick="toggleDay(3)" data-day="3" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white">Wed</button>
              <button type="button" onclick="toggleDay(4)" data-day="4" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white">Thu</button>
              <button type="button" onclick="toggleDay(5)" data-day="5" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white">Fri</button>
              <button type="button" onclick="toggleDay(6)" data-day="6" class="work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50">Sat</button>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Morning Break (min)</label>
              <input id="s-break-morning" type="number" value="15" min="0" max="60" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Lunch (min)</label>
              <input id="s-break-lunch" type="number" value="30" min="0" max="120" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Afternoon Break (min)</label>
              <input id="s-break-afternoon" type="number" value="15" min="0" max="60" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Paid Hours per Day</label>
            <input id="s-paid-hours" type="number" step="0.5" min="1" max="12" value="7.5" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Standard: 8h shift − 30min lunch = 7.5h paid</p>
          </div>
        </div>

        <!-- Stat Pay -->
        <div class="space-y-4">
          <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2">Statutory Holiday Pay</h4>
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
            <p class="font-semibold mb-1"><i class="fas fa-info-circle mr-1"></i> Stat Pay Rules (by province)</p>
            <div id="stat-pay-info" class="text-xs space-y-1 mt-2"></div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Stat Pay Multiplier</label>
            <input id="s-stat-multiplier" type="number" step="0.25" min="1" max="3" value="1.5" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">e.g. 1.5 = time and a half. Auto-set when province changes.</p>
          </div>
          <div>
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" id="s-stat-pay-enabled" class="w-4 h-4 rounded accent-indigo-600" checked/>
              <span class="text-sm font-medium text-gray-700">Enable statutory holiday pay</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Pay Period Settings -->
      <div class="mt-6 space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <i class="fas fa-calendar-check text-emerald-500"></i> Pay Period
        </h4>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Pay Frequency</label>
            <select id="s-pay-frequency" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm">
              <option value="weekly">Weekly (every Friday)</option>
              <option value="biweekly" selected>Bi-weekly (every 2nd Friday)</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">First Payday (anchor date)</label>
            <input id="s-pay-anchor" type="date" value="2026-03-06"
              class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Set to your next upcoming payday — all future paydays auto-calculate</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Show Pay to Workers</label>
            <label class="flex items-center gap-3 mt-3 cursor-pointer">
              <input type="checkbox" id="s-show-pay-workers" class="w-4 h-4 rounded accent-emerald-600" checked/>
              <span class="text-sm font-medium text-gray-700">Workers can see their gross earnings</span>
            </label>
            <p class="text-xs text-gray-400 mt-1">If off, workers see hours only, no dollar amounts</p>
          </div>
        </div>
        <!-- Accountant / QB Settings -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 p-4 bg-amber-50 border border-amber-200 rounded-2xl">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              <i class="fas fa-envelope text-amber-500 mr-1"></i> Accountant Email
            </label>
            <input id="s-accountant-email" type="email" placeholder="accountant@yourfirm.com"
              class="w-full px-3 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Pre-filled on the Payroll Export tab — saved with settings</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              <i class="fas fa-building text-amber-500 mr-1"></i> Company Name (for QB files)
            </label>
            <input id="s-company-name" type="text" placeholder="Your Company Ltd."
              class="w-full px-3 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-400 text-sm"/>
            <p class="text-xs text-gray-400 mt-1">Appears inside QB IIF files as the company identifier</p>
          </div>
        </div>
      </div>

      <!-- QuickBooks Online Direct Connect -->
      <div class="space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <img src="https://upload.wikimedia.org/wikipedia/commons/9/9d/Intuit_QuickBooks_logo.png" class="h-4 w-auto" onerror="this.style.display='none'"/>
          <i class="fas fa-link text-green-600"></i> QuickBooks Online — Direct Connect
        </h4>
        <div class="bg-green-50 border border-green-200 rounded-2xl p-4 space-y-4">
          <!-- Status Banner -->
          <div id="qb-settings-status" class="flex items-center gap-3 p-3 rounded-xl bg-white border border-green-200">
            <div id="qb-status-dot" class="w-3 h-3 rounded-full bg-gray-300 flex-shrink-0"></div>
            <div class="flex-1">
              <p id="qb-status-text" class="text-sm font-semibold text-gray-600">Checking connection…</p>
              <p id="qb-company-name-display" class="text-xs text-gray-400"></p>
            </div>
            <button id="qb-connect-btn" onclick="qbConnect()"
              class="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg transition-colors">
              Connect to QuickBooks
            </button>
            <button id="qb-disconnect-btn" onclick="qbDisconnect()" style="display:none"
              class="px-4 py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-xs font-semibold rounded-lg transition-colors">
              Disconnect
            </button>
          </div>
          <!-- Credentials -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                <i class="fas fa-key text-green-500 mr-1"></i> Intuit Client ID
              </label>
              <input id="s-qb-client-id" type="text" placeholder="ABCDEFabcdef…"
                class="w-full px-3 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-400 text-sm font-mono"/>
              <p class="text-xs text-gray-400 mt-1">From developer.intuit.com → My Apps → Keys</p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                <i class="fas fa-lock text-green-500 mr-1"></i> Intuit Client Secret
              </label>
              <input id="s-qb-client-secret" type="password" placeholder="••••••••••••"
                class="w-full px-3 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-400 text-sm font-mono"/>
              <p class="text-xs text-gray-400 mt-1">Keep secret — never share this value</p>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Environment</label>
              <select id="s-qb-environment"
                class="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-400">
                <option value="production">Production (live QB company)</option>
                <option value="sandbox">Sandbox (testing)</option>
              </select>
            </div>
            <div class="flex-1 bg-green-100 rounded-xl p-3 text-xs text-green-800">
              <strong>How it works:</strong> Save your Client ID &amp; Secret → click Connect → approve in QuickBooks → 
              hours sync automatically each pay period. No manual CSV import needed.
            </div>
          </div>
          <p class="text-xs text-gray-500">
            <i class="fas fa-info-circle mr-1 text-blue-400"></i>
            Get free credentials at <a href="https://developer.intuit.com" target="_blank" class="text-blue-500 underline">developer.intuit.com</a> → 
            Create App → QuickBooks Online → copy Client ID &amp; Secret. 
            Set Redirect URI to: <code id="qb-redirect-uri-display" class="bg-white px-1 rounded text-xs text-gray-700">https://admin.clockinproof.com/api/qb/callback</code>
          </p>
        </div>
      </div>

      <!-- GPS Fraud Prevention -->
      <div class="space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <i class="fas fa-shield-alt text-red-500"></i> GPS Fraud Prevention
        </h4>
        <div class="bg-red-50 border border-red-200 rounded-2xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div>
              <p class="text-sm font-semibold text-gray-700">Enable GPS Location Check</p>
              <p class="text-xs text-gray-500">Block clock-in if worker is too far from the job site</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="s-gps-fraud-check" class="sr-only peer" checked/>
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-red-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
            </label>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Geofence Radius <span class="text-gray-400 font-normal">(metres — worker must be within this distance)</span>
            </label>
            <div class="flex items-center gap-3">
              <input id="s-geofence-radius" type="number" min="50" max="5000" step="50" value="300"
                class="flex-1 px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-red-400 text-sm"/>
              <div class="flex gap-1">
                <button onclick="setVal('s-geofence-radius','50')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">50m</button>
                <button onclick="setVal('s-geofence-radius','100')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">100m</button>
                <button onclick="setVal('s-geofence-radius','300')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">300m</button>
                <button onclick="setVal('s-geofence-radius','500')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">500m</button>
                <button onclick="setVal('s-geofence-radius','1000')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">1km</button>
              </div>
            </div>
            <p class="text-xs text-gray-400 mt-1">
              Recommended: 300m in cities, 500-1000m in suburban areas. Currently: when a worker enters "29 Birchbank Cres" but is actually at home, they will be blocked.
            </p>
          </div>
        </div>
        <div class="text-xs text-gray-500 flex items-start gap-2">
          <i class="fas fa-info-circle text-blue-400 mt-0.5 flex-shrink-0"></i>
          <span>When blocked, the worker sees a map showing their actual location vs the job site and must wait for admin approval under the <strong>Overrides</strong> tab.</span>
        </div>
      </div>

      <!-- Shift Guardrails -->
      <div class="space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <i class="fas fa-user-clock text-purple-500"></i> Shift Guardrails
          <span class="text-xs font-normal text-gray-400 normal-case tracking-normal">Prevent workers forgetting to sign out or leaving the site</span>
        </h4>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Auto Clock-Out -->
          <div class="bg-purple-50 border border-purple-200 rounded-2xl p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <i class="fas fa-clock text-purple-500"></i>
                <span class="text-sm font-semibold text-gray-700">Auto Clock-Out</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" id="s-auto-clockout" class="sr-only peer" checked/>
                <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-500"></div>
              </label>
            </div>
            <p class="text-xs text-gray-500 mb-3">Automatically clock out a worker who has been signed in too long (max shift) or past the scheduled work end time.</p>
            <label class="text-xs font-medium text-gray-600 block mb-1">Max Shift Length</label>
            <div class="flex items-center gap-2">
              <input id="s-max-shift-hours" type="number" min="4" max="24" step="0.5" value="10"
                class="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"/>
              <span class="text-xs text-gray-500">hours</span>
            </div>
            <div class="flex gap-1 mt-2 flex-wrap">
              <button onclick="setVal('s-max-shift-hours','8')"  class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">8h</button>
              <button onclick="setVal('s-max-shift-hours','10')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">10h</button>
              <button onclick="setVal('s-max-shift-hours','12')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">12h</button>
            </div>
          </div>

          <!-- Away / Idle Warning -->
          <div class="bg-yellow-50 border border-yellow-200 rounded-2xl p-4">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-wifi text-yellow-500"></i>
              <span class="text-sm font-semibold text-gray-700">Idle / Away Warning</span>
            </div>
            <p class="text-xs text-gray-500 mb-3">Alert the worker (and flag the session) if no GPS ping is received — means the app is closed or the phone is off-site.</p>
            <label class="text-xs font-medium text-gray-600 block mb-1">Warn after no GPS update for</label>
            <div class="flex items-center gap-2">
              <input id="s-away-warning-min" type="number" min="5" max="120" step="5" value="30"
                class="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"/>
              <span class="text-xs text-gray-500">minutes</span>
            </div>
            <div class="flex gap-1 mt-2 flex-wrap">
              <button onclick="setVal('s-away-warning-min','15')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">15m</button>
              <button onclick="setVal('s-away-warning-min','30')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">30m</button>
              <button onclick="setVal('s-away-warning-min','60')" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">60m</button>
            </div>
          </div>

          <!-- Geofence Exit Auto-Clockout -->
          <div class="bg-orange-50 border border-orange-200 rounded-2xl p-4">
            <div class="flex items-center gap-2 mb-3">
              <i class="fas fa-map-marker-slash text-orange-500"></i>
              <span class="text-sm font-semibold text-gray-700">Geofence Exit Auto-Clockout</span>
            </div>
            <p class="text-xs text-gray-500 mb-3">Automatically clock out a worker if they stay outside the job-site geofence for too long. Set to <strong>0</strong> to disable (admin must clock out manually via the Live tab).</p>
            <label class="text-xs font-medium text-gray-600 block mb-1">Auto clock-out after leaving geofence for</label>
            <div class="flex items-center gap-2">
              <input id="s-geofence-exit-min" type="number" min="0" max="480" step="5" value="0"
                class="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"/>
              <span class="text-xs text-gray-500">minutes (0 = manual only)</span>
            </div>
            <div class="flex gap-1 mt-2 flex-wrap">
              <button onclick="setVal('s-geofence-exit-min','0')"  class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">Off</button>
              <button onclick="setVal('s-geofence-exit-min','15')" class="px-2 py-1 text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg">15m</button>
              <button onclick="setVal('s-geofence-exit-min','30')" class="px-2 py-1 text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg">30m</button>
              <button onclick="setVal('s-geofence-exit-min','60')" class="px-2 py-1 text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 rounded-lg">60m</button>
            </div>
          </div>
        </div>

        <div class="text-xs text-gray-500 flex items-start gap-2 bg-gray-50 rounded-xl p-3">
          <i class="fas fa-info-circle text-purple-400 mt-0.5 flex-shrink-0"></i>
          <span>Workers see a coloured warning banner before auto clock-out. The admin Live tab shows <span class="font-medium text-orange-600">⚠ Drifted</span>, <span class="font-medium text-yellow-600">⏰ Away</span>, and <span class="font-medium text-red-600">🔴 Auto clocked-out</span> badges. All guardrail events are recorded on the session for your records.</span>
        </div>
      </div>

      <!-- Notifications — Platform-managed, no tenant setup needed -->
      <div class="space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <i class="fas fa-bell text-amber-500"></i> Notifications
          <span class="text-xs font-normal text-gray-400 normal-case tracking-normal">Alert channels for overrides, auto clock-outs &amp; dispatches</span>
        </h4>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Email toggle -->
          <div class="bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <i class="fas fa-envelope text-amber-500"></i>
                <span class="text-sm font-semibold text-gray-700">Email Alert</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" id="s-notify-email" class="sr-only peer" checked/>
                <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500"></div>
              </label>
            </div>
            <p class="text-xs text-gray-500 mb-2">Rich HTML email with map link, worker details, and a direct approval link.</p>
            <p class="text-xs text-green-600 font-medium"><i class="fas fa-check-circle mr-1"></i>Included — powered by ClockInProof platform</p>
          </div>

          <!-- SMS toggle -->
          <div class="bg-blue-50 border border-blue-200 rounded-2xl p-4">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <i class="fas fa-sms text-blue-500"></i>
                <span class="text-sm font-semibold text-gray-700">SMS / Text Alert</span>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" id="s-notify-sms" class="sr-only peer"/>
                <div class="w-10 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
              </label>
            </div>
            <p class="text-xs text-gray-500 mb-2">Instant SMS with a deep-link to the Overrides tab. Works on Android &amp; iOS.</p>
            <p class="text-xs text-green-600 font-medium"><i class="fas fa-check-circle mr-1"></i>Included — powered by ClockInProof platform</p>
          </div>
        </div>

        <!-- Admin phone number (tenant sets their own) -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Admin Phone Number <span class="text-gray-400 font-normal">(for SMS alerts — include country code e.g. +1 613 555 0100)</span>
          </label>
          <input id="s-admin-phone" type="tel" placeholder="+1 613 555 0100"
            class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 text-sm"/>
          <p class="text-xs text-gray-400 mt-1"><i class="fas fa-info-circle mr-1"></i>SMS alerts for overrides, auto clock-outs, and dispatches are sent to this number.</p>
        </div>

        <!-- Info note -->
        <div class="bg-indigo-50 border border-indigo-100 rounded-xl p-3 text-xs text-indigo-600 flex items-start gap-2">
          <i class="fas fa-shield-halved text-indigo-400 mt-0.5 flex-shrink-0"></i>
          <span>All messaging is handled by the ClockInProof platform — no external accounts or API keys required. Email and SMS are included in your plan.</span>
        </div>
      </div>

      <div class="mt-6 flex gap-3">
        <button onclick="saveSettings()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl">
          <i class="fas fa-save mr-2"></i>Save Settings
        </button>
        <button onclick="loadSettings()" class="px-6 border border-gray-300 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50">
          <i class="fas fa-undo mr-1"></i>Reset
        </button>
      </div>
    </div>

    <!-- Tab: Export -->
    <div id="tab-export" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <h3 class="font-bold text-gray-700 mb-5 flex items-center gap-2">
        <i class="fas fa-file-export text-indigo-500"></i> Payroll Timesheets & Export
      </h3>

      <!-- Week selector -->
      <div class="bg-indigo-50 border border-indigo-200 rounded-2xl p-5 mb-5">
        <div class="flex items-center gap-3 flex-wrap">
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">Select Week</label>
            <input type="date" id="export-week-date"
              class="border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
          </div>
          <div class="flex-1 min-w-[200px]">
            <label class="block text-sm font-semibold text-gray-700 mb-1">Week Range</label>
            <p id="export-week-label" class="text-sm font-bold text-indigo-700 mt-1 py-2.5">—</p>
          </div>
        </div>
        <div class="flex gap-3 mt-4 flex-wrap">
          <button onclick="setExportWeek(-1)" class="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50">
            <i class="fas fa-chevron-left mr-1"></i>Previous Week
          </button>
          <button onclick="setExportWeek(0)" class="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700">
            <i class="fas fa-calendar-check mr-1"></i>This Week
          </button>
          <button onclick="setExportWeek(1)" class="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50">
            Next Week<i class="fas fa-chevron-right ml-1"></i>
          </button>
        </div>
      </div>

      <!-- Worker selector -->
      <div class="bg-white border-2 border-gray-100 rounded-2xl p-4 mb-5">
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-user-hard-hat text-indigo-400 mr-1"></i> Export For
        </label>
        <div class="flex items-center gap-3 flex-wrap">
          <select id="export-worker-select"
            class="flex-1 min-w-[200px] border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
            <option value="">📋 All Staff (Combined Report)</option>
          </select>
          <span id="export-worker-badge"
            class="px-3 py-1.5 bg-indigo-50 text-indigo-700 text-xs font-bold rounded-full border border-indigo-200">
            All Workers
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-2">
          <i class="fas fa-info-circle mr-1"></i>
          Select a specific worker for an individual timesheet, or leave as "All Staff" for the full payroll report.
        </p>
      </div>

      <!-- Export actions -->
      <div class="grid grid-cols-1 gap-3 mb-5">

        <!-- Row 1: View + CSV side by side -->
        <div class="grid grid-cols-2 gap-3">
          <!-- View HTML Report -->
          <div class="border-2 border-indigo-100 rounded-2xl p-4 hover:border-indigo-300 transition-colors">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <i class="fas fa-eye text-indigo-600"></i>
              </div>
              <div>
                <h4 class="font-bold text-gray-800 text-sm">View Report</h4>
                <p class="text-xs text-gray-400">Full timesheet + GPS proof</p>
              </div>
            </div>
            <button onclick="viewWeeklyReport()"
              class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-xl text-sm">
              <i class="fas fa-external-link-alt mr-1"></i>Open
            </button>
          </div>

          <!-- Download CSV -->
          <div class="border-2 border-green-100 rounded-2xl p-4 hover:border-green-300 transition-colors">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <i class="fas fa-file-csv text-green-600"></i>
              </div>
              <div>
                <h4 class="font-bold text-gray-800 text-sm">Download CSV</h4>
                <p class="text-xs text-gray-400">Excel-ready spreadsheet</p>
              </div>
            </div>
            <button onclick="downloadCSV()"
              class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl text-sm">
              <i class="fas fa-download mr-1"></i>Download
            </button>
          </div>
        </div>

        <!-- Row 2: Email full width -->
        <div class="border-2 border-amber-100 rounded-2xl p-4 hover:border-amber-300 transition-colors">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <i class="fas fa-envelope text-amber-600"></i>
              </div>
              <div>
                <h4 class="font-bold text-gray-800 text-sm">Email Report</h4>
                <p class="text-xs text-gray-400">Send to admin email (requires RESEND_API_KEY)</p>
              </div>
            </div>
            <button onclick="emailWeeklyReport()" id="email-report-btn"
              class="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-xl text-sm">
              <i class="fas fa-paper-plane mr-1"></i>Send Email
            </button>
          </div>
        </div>

      </div>

      <!-- Export status -->
      <div id="export-email-status" class="hidden rounded-xl p-4 mb-4 text-sm"></div>

      <!-- Auto schedule info -->
      <div class="bg-gray-50 border border-gray-200 rounded-2xl p-5">
        <h4 class="font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <i class="fas fa-robot text-indigo-500"></i> Automatic Weekly Email Schedule
        </h4>
        <div class="space-y-2 text-sm text-gray-600">
          <div class="flex items-start gap-2">
            <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
            <span><strong>Schedule:</strong> Every Friday at 11:59 PM — covers Monday 12:00 AM to Friday 11:59 PM</span>
          </div>
          <div class="flex items-start gap-2">
            <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
            <span><strong>Content:</strong> Full timesheet + hours + earnings per worker</span>
          </div>
          <div class="flex items-start gap-2" id="auto-email-config-status">
            <i class="fas fa-exclamation-circle text-yellow-500 mt-0.5 flex-shrink-0"></i>
            <span><strong>Setup required:</strong> Add your admin email in Settings, then add <code class="bg-gray-100 px-1 rounded">RESEND_API_KEY</code> as a Cloudflare secret</span>
          </div>
          <div class="flex items-start gap-2">
            <i class="fas fa-clock text-blue-500 mt-0.5 flex-shrink-0"></i>
            <span id="last-email-sent-info" class="text-gray-500">Last sent: —</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Tab: Payroll Totals ─────────────────────────────────────────────── -->
    <div id="tab-payroll" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
        <h3 class="font-bold text-gray-800 text-lg flex items-center gap-2">
          <i class="fas fa-dollar-sign text-purple-500"></i> Payroll Totals
        </h3>
        <div class="flex gap-2 flex-wrap">
          <button onclick="changePeriod('today');loadPayrollTab()" class="px-3 py-1.5 text-xs rounded-xl bg-white border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 font-medium">Today</button>
          <button onclick="changePeriod('week');loadPayrollTab()" class="px-3 py-1.5 text-xs rounded-xl bg-white border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 font-medium">This Week</button>
          <button onclick="changePeriod('month');loadPayrollTab()" class="px-3 py-1.5 text-xs rounded-xl bg-white border border-gray-200 text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 font-medium">This Month</button>
          <button onclick="changePeriod('all');loadPayrollTab()" class="px-3 py-1.5 text-xs rounded-xl bg-indigo-600 text-white font-medium">All Time</button>
        </div>
      </div>

      <!-- Summary totals banner -->
      <div class="grid grid-cols-3 gap-3 mb-6">
        <div class="bg-purple-50 border border-purple-100 rounded-2xl p-4 text-center">
          <p class="text-2xl font-bold text-purple-700" id="pt-total-payroll">–</p>
          <p class="text-xs text-purple-500 mt-0.5 font-medium">Total Payroll</p>
        </div>
        <div class="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-center">
          <p class="text-2xl font-bold text-blue-700" id="pt-total-hours">–</p>
          <p class="text-xs text-blue-500 mt-0.5 font-medium">Total Hours</p>
        </div>
        <div class="bg-green-50 border border-green-100 rounded-2xl p-4 text-center">
          <p class="text-2xl font-bold text-green-700" id="pt-total-workers">–</p>
          <p class="text-xs text-green-500 mt-0.5 font-medium">Workers Paid</p>
        </div>
      </div>

      <!-- Per-worker breakdown -->
      <div id="payroll-workers-list" class="space-y-3">
        <p class="text-gray-400 text-center py-8"><i class="fas fa-spinner fa-spin mr-2"></i>Loading payroll data...</p>
      </div>
    </div>

    <!-- ── Tab: Weekly Summary → Accountant ───────────────────────────────── -->
    <div id="tab-accountant" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h3 class="font-bold text-gray-800 text-lg flex items-center gap-2">
            <i class="fas fa-file-invoice-dollar text-amber-500"></i> Payroll Export &amp; Accountant
          </h3>
          <p class="text-sm text-gray-400 mt-0.5">Export QuickBooks-ready payroll files and email to your accountant</p>
        </div>
      </div>

      <!-- ── Pay Period Selector ── -->
      <div class="bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-2xl p-5 mb-5">
        <div class="flex items-center gap-2 mb-3">
          <i class="fas fa-calendar-alt text-indigo-600"></i>
          <h4 class="font-bold text-gray-800 text-sm">Select Pay Period</h4>
        </div>
        <div class="flex gap-3 flex-wrap mb-3">
          <div class="flex-1 min-w-[140px]">
            <label class="block text-xs font-semibold text-gray-600 mb-1">Start Date</label>
            <input type="date" id="qb-start"
              class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div class="flex-1 min-w-[140px]">
            <label class="block text-xs font-semibold text-gray-600 mb-1">End Date</label>
            <input type="date" id="qb-end"
              class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
        </div>
        <!-- Quick-select pay periods -->
        <div class="mb-2">
          <label class="block text-xs font-semibold text-gray-500 mb-1.5">Quick Select Pay Period:</label>
          <div id="qb-period-list" class="flex flex-wrap gap-2">
            <span class="text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>Loading pay periods...</span>
          </div>
        </div>
        <div class="flex gap-2 mt-3 flex-wrap">
          <button onclick="setQbCustomRange('this_week')" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-50">
            This Week
          </button>
          <button onclick="setQbCustomRange('last_week')" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-50">
            Last Week
          </button>
          <button onclick="setQbCustomRange('this_month')" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-50">
            This Month
          </button>
          <button onclick="setQbCustomRange('last_month')" class="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 rounded-xl text-xs font-medium hover:bg-gray-50">
            Last Month
          </button>
          <button onclick="loadQbPreview()" class="ml-auto px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-sm">
            <i class="fas fa-eye mr-1"></i>Preview
          </button>
        </div>
      </div>

      <!-- ── QB Export Buttons ── -->
      <div class="bg-white border border-gray-200 rounded-2xl p-5 mb-5">
        <div class="flex items-center gap-2 mb-3">
          <i class="fas fa-download text-green-600"></i>
          <h4 class="font-bold text-gray-800 text-sm">Download QuickBooks Files</h4>
        </div>
        <div class="grid grid-cols-1 gap-3">
          <!-- QB Online CSV -->
          <button onclick="downloadQbFile('csv')"
            class="flex items-center gap-3 p-4 bg-green-50 hover:bg-green-100 border border-green-200 rounded-xl transition-all group">
            <div class="w-10 h-10 bg-green-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm">
              <i class="fas fa-table text-white"></i>
            </div>
            <div class="text-left flex-1">
              <p class="font-bold text-green-800 text-sm">QuickBooks Online — CSV</p>
              <p class="text-xs text-green-600">Payroll → Import → upload CSV · Works with QB Online &amp; most accounting software</p>
            </div>
            <i class="fas fa-download text-green-600 group-hover:text-green-800"></i>
          </button>
          <!-- QB Desktop IIF -->
          <button onclick="downloadQbFile('iif')"
            class="flex items-center gap-3 p-4 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-all group">
            <div class="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm">
              <i class="fas fa-file-code text-white"></i>
            </div>
            <div class="text-left flex-1">
              <p class="font-bold text-blue-800 text-sm">QuickBooks Desktop — IIF</p>
              <p class="text-xs text-blue-600">File → Utilities → Import → IIF Files · Imports hours directly into timesheets</p>
            </div>
            <i class="fas fa-download text-blue-600 group-hover:text-blue-800"></i>
          </button>
          <!-- Full Detail CSV -->
          <button onclick="downloadQbFile('detail')"
            class="flex items-center gap-3 p-4 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl transition-all group">
            <div class="w-10 h-10 bg-gray-500 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm">
              <i class="fas fa-file-csv text-white"></i>
            </div>
            <div class="text-left flex-1">
              <p class="font-bold text-gray-800 text-sm">Full Detail Report — CSV</p>
              <p class="text-xs text-gray-500">Every clock-in/out with GPS · for records &amp; audit</p>
            </div>
            <i class="fas fa-download text-gray-500 group-hover:text-gray-700"></i>
          </button>
        </div>
      </div>

      <!-- ── Email to Accountant ── -->
      <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-5">
        <div class="flex items-center gap-2 mb-3">
          <i class="fas fa-paper-plane text-amber-600"></i>
          <h4 class="font-bold text-gray-800 text-sm">Email to Accountant</h4>
          <span class="ml-auto text-xs bg-amber-200 text-amber-800 px-2 py-0.5 rounded-full font-semibold">with QB files attached</span>
        </div>
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">Accountant Email</label>
          <input id="qb-acct-email" type="email" placeholder="accountant@yourfirm.com"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
          <p class="text-xs text-gray-400 mt-1">Saved automatically. Also CC'd to your admin email.</p>
        </div>
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">Attach Format</label>
          <div class="flex gap-3">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="qb-fmt" value="both" checked class="accent-amber-500"> <span class="text-sm text-gray-700">Both (CSV + IIF)</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="qb-fmt" value="csv" class="accent-amber-500"> <span class="text-sm text-gray-700">CSV only</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="qb-fmt" value="iif" class="accent-amber-500"> <span class="text-sm text-gray-700">IIF only</span>
            </label>
          </div>
        </div>
        <button onclick="sendQbToAccountant()" id="qb-send-btn"
          class="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-3 rounded-xl text-sm transition-colors shadow-md shadow-amber-200 flex items-center justify-center gap-2">
          <i class="fas fa-paper-plane"></i> Send Payroll Report to Accountant
        </button>
        <div id="qb-send-status" class="hidden mt-3 rounded-xl p-3 text-sm"></div>
      </div>

      <!-- ── Preview ── -->
      <div>
        <div class="flex items-center justify-between mb-3">
          <h4 class="font-bold text-gray-700 text-sm flex items-center gap-2">
            <i class="fas fa-chart-bar text-purple-500"></i> Period Preview
          </h4>
          <p id="qb-period-label" class="text-xs text-gray-400">Select a pay period above</p>
        </div>
        <div id="qb-preview" class="space-y-3">
          <div class="text-center py-10 text-gray-400">
            <i class="fas fa-file-invoice-dollar text-4xl mb-3 block text-gray-200"></i>
            <p class="text-sm">Select a pay period and click <strong>Preview</strong></p>
          </div>
        </div>
      </div>

      <!-- legacy week-based send still works -->
      <div id="acct-send-status" class="hidden mt-4 rounded-xl p-4 text-sm"></div>
    </div>

    <!-- ── Tab: QuickBooks Sync ───────────────────────────────────────────── -->
    <div id="tab-quickbooks" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5">
        <h3 class="font-bold text-gray-700 flex items-center gap-2 text-lg">
          <i class="fas fa-plug text-green-600"></i>
          QuickBooks Online — Direct Sync
        </h3>
        <span class="text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full font-semibold">Beta</span>
      </div>

      <!-- Connection Status Card -->
      <div id="qb-tab-status-card" class="rounded-2xl border-2 p-5 mb-6 flex items-center gap-4">
        <div id="qb-tab-status-icon" class="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-gray-100">
          <i class="fas fa-circle-notch fa-spin text-gray-400"></i>
        </div>
        <div class="flex-1">
          <p id="qb-tab-status-title" class="font-bold text-gray-700 text-base">Checking connection…</p>
          <p id="qb-tab-status-sub" class="text-sm text-gray-500"></p>
        </div>
        <div class="flex gap-2">
          <button id="qb-tab-connect-btn" onclick="qbConnect()"
            class="hidden px-5 py-2 bg-green-600 hover:bg-green-700 text-white font-bold text-sm rounded-xl transition-colors">
            <i class="fas fa-link mr-1"></i> Connect to QuickBooks
          </button>
          <button id="qb-tab-disconnect-btn" onclick="qbDisconnect()"
            class="hidden px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 font-semibold text-sm rounded-xl border border-red-200 transition-colors">
            <i class="fas fa-unlink mr-1"></i> Disconnect
          </button>
        </div>
      </div>

      <!-- Setup steps (shown when not connected) -->
      <div id="qb-setup-steps" class="mb-6 bg-blue-50 border border-blue-200 rounded-2xl p-4">
        <p class="font-bold text-blue-800 mb-3 flex items-center gap-2">
          <i class="fas fa-list-ol"></i> Quick Setup — 3 Steps
        </p>
        <ol class="space-y-2 text-sm text-blue-700">
          <li class="flex gap-3">
            <span class="w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <span>Go to <a href="https://developer.intuit.com" target="_blank" class="underline font-medium">developer.intuit.com</a> → Create App → QuickBooks Online → copy <strong>Client ID</strong> &amp; <strong>Client Secret</strong></span>
          </li>
          <li class="flex gap-3">
            <span class="w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
            <span>In your Intuit App settings, add Redirect URI: <code class="bg-white px-1 rounded text-xs font-mono text-blue-900">https://admin.clockinproof.com/api/qb/callback</code></span>
          </li>
          <li class="flex gap-3">
            <span class="w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
            <span>Go to <strong>Settings → QuickBooks Direct Connect</strong>, enter Client ID &amp; Secret, save, then click <strong>Connect to QuickBooks</strong></span>
          </li>
        </ol>
      </div>

      <!-- Employee Mapping Section (shown when connected) -->
      <div id="qb-mapping-section" class="hidden">
        <div class="flex items-center justify-between mb-3">
          <h4 class="font-bold text-gray-700 flex items-center gap-2">
            <i class="fas fa-users text-indigo-500"></i> Employee Mapping
          </h4>
          <button onclick="loadQbMapping()"
            class="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1">
            <i class="fas fa-sync-alt"></i> Refresh
          </button>
        </div>
        <p class="text-xs text-gray-500 mb-2">
          Match each of your workers (left) to their record in your accountant's QuickBooks (right). 
          Once mapped, hours sync automatically.
        </p>
        <div class="mb-3">
          <button onclick="qbAutoMap()" class="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold px-3 py-1.5 rounded-lg border border-indigo-200 transition-colors">
            <i class="fas fa-magic mr-1"></i> Auto-Match by Name
          </button>
          <span class="text-xs text-gray-400 ml-2">or map each worker manually below</span>
        </div>
        <div id="qb-mapping-list" class="space-y-2">
          <p class="text-gray-400 text-sm text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>
        </div>
      </div>

      <!-- Sync Section (shown when connected) -->
      <div id="qb-sync-section" class="hidden mt-6">
        <h4 class="font-bold text-gray-700 flex items-center gap-2 mb-3">
          <i class="fas fa-cloud-upload-alt text-green-500"></i> Push Hours to QuickBooks
        </h4>

        <!-- Period Selector -->
        <div class="bg-gray-50 border border-gray-200 rounded-2xl p-4 mb-4">
          <p class="text-sm font-semibold text-gray-600 mb-2">Select Pay Period</p>
          <div class="flex gap-3 mb-3 flex-wrap">
            <button onclick="setQbSyncPeriod('this_period')"
              class="px-3 py-1.5 text-xs bg-white border border-gray-200 hover:border-indigo-400 rounded-lg font-medium transition-colors">
              Current Pay Period
            </button>
            <button onclick="setQbSyncPeriod('last_period')"
              class="px-3 py-1.5 text-xs bg-white border border-gray-200 hover:border-indigo-400 rounded-lg font-medium transition-colors">
              Last Pay Period
            </button>
            <button onclick="setQbSyncPeriod('this_month')"
              class="px-3 py-1.5 text-xs bg-white border border-gray-200 hover:border-indigo-400 rounded-lg font-medium transition-colors">
              This Month
            </button>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">Start Date</label>
              <input type="date" id="qb-sync-start"
                class="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-400"/>
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">End Date</label>
              <input type="date" id="qb-sync-end"
                class="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-400"/>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="flex gap-3 mb-4 flex-wrap">
          <button onclick="runQbSync(true)"
            class="flex-1 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-colors flex items-center justify-center gap-2">
            <i class="fas fa-eye"></i> Preview (Dry Run)
          </button>
          <button onclick="runQbSync(false)"
            class="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white font-bold text-sm rounded-xl transition-colors flex items-center justify-center gap-2">
            <i class="fas fa-cloud-upload-alt"></i> Push to QuickBooks
          </button>
        </div>

        <!-- Sync Results -->
        <div id="qb-sync-results" class="hidden rounded-2xl border p-4 text-sm"></div>
      </div>

      <!-- Sync Log Section -->
      <div id="qb-log-section" class="hidden mt-6">
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-bold text-gray-700 flex items-center gap-2 text-sm">
            <i class="fas fa-history text-gray-400"></i> Sync History
          </h4>
          <button onclick="loadQbSyncLog()"
            class="text-xs text-gray-500 hover:text-gray-700 font-medium flex items-center gap-1">
            <i class="fas fa-sync-alt"></i> Refresh
          </button>
        </div>
        <div id="qb-sync-log" class="space-y-2"></div>
      </div>
    </div>

    <!-- ── Tab: Overrides ─────────────────────────────────────────────────── -->
    <div id="tab-overrides" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
  <div class="flex items-center justify-between mb-5">
    <h3 class="font-bold text-gray-700 flex items-center gap-2">
      <i class="fas fa-shield-alt text-red-500"></i>
      Clock-In Override Requests
      <span id="overrides-count" class="bg-red-100 text-red-600 text-xs font-bold px-2 py-0.5 rounded-full ml-1">0</span>
    </h3>
    <div class="flex gap-2">
      <button onclick="loadOverrides()" class="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5 border border-gray-200 rounded-xl">
        <i class="fas fa-sync-alt mr-1"></i>Refresh
      </button>
      <button onclick="showOverrideHistory()" class="text-sm text-indigo-600 hover:text-indigo-700 px-3 py-1.5 border border-indigo-200 rounded-xl">
        <i class="fas fa-history mr-1"></i>History
      </button>
    </div>
  </div>

  <!-- Explanation banner -->
  <div class="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-5">
    <div class="flex items-start gap-3">
      <i class="fas fa-info-circle text-blue-500 mt-0.5"></i>
      <div>
        <p class="text-sm font-semibold text-blue-700 mb-1">How GPS Fraud Prevention Works</p>
        <p class="text-xs text-blue-600">When a worker tries to clock in, the app compares their <strong>actual GPS position</strong> against the job site address they entered. If the distance exceeds the geofence radius (set in Settings), the clock-in is <strong>blocked</strong> and an override request is sent here. You can <strong>Approve</strong> or <strong>Deny</strong> each request below.</p>
      </div>
    </div>
  </div>

  <!-- Pending overrides list -->
  <div id="overrides-list">
    <p class="text-gray-400 text-center py-12"><i class="fas fa-check-circle text-green-400 text-3xl mb-3 block"></i>No pending override requests. All workers are clocking in from their job sites.</p>
  </div>

  <!-- History section (hidden by default) -->
  <div id="overrides-history" class="hidden mt-6">
    <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 mb-4">Override History (Last 100)</h4>
    <div id="overrides-history-list" class="space-y-2"></div>
  </div>
    </div><!-- /tab-overrides -->

    <!-- ── Tab: Job Sites ──────────────────────────────────────────────────── -->
    <div id="tab-job-sites" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5">
        <div>
          <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-map-marker-alt text-emerald-500 mr-2"></i>Job Sites</h3>
          <p class="text-xs text-gray-500 mt-0.5">Save job site addresses. Workers pick from this list when clocking in.</p>
        </div>
        <button onclick="openAddSiteModal()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-xl flex items-center gap-2 shadow-sm">
          <i class="fas fa-plus"></i> Add Site
        </button>
      </div>
      <div id="job-sites-list" class="space-y-3">
        <p class="text-gray-400 text-sm text-center py-8"><i class="fas fa-map-marker-alt text-3xl mb-3 block text-gray-300"></i>No job sites added yet.</p>
      </div>
    </div>

    <div id="tab-job-sites" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5">
        <div>
          <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-map-marker-alt text-emerald-500 mr-2"></i>Job Sites</h3>
          <p class="text-xs text-gray-500 mt-0.5">Save job site addresses. Workers pick from this list when clocking in.</p>
        </div>
        <button onclick="openAddSiteModal()" class="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-xl flex items-center gap-2 shadow-sm">
          <i class="fas fa-plus"></i> Add Site
        </button>
      </div>
      <div id="job-sites-list" class="space-y-3">
        <p class="text-gray-400 text-sm text-center py-8"><i class="fas fa-map-marker-alt text-3xl mb-3 block text-gray-300"></i>No job sites added yet.</p>
      </div>
    </div>

    <!-- ── Tab: Job Dispatch ──────────────────────────────────────────────── -->
    <div id="tab-dispatch" class="tab-content hidden space-y-5">

      <!-- Header -->
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 class="text-lg font-bold text-gray-800 flex items-center gap-2">
              <i class="fas fa-paper-plane text-violet-500"></i>Job Dispatch
            </h3>
            <p class="text-xs text-gray-500 mt-0.5">Send a job to a worker via SMS. They get a Google Maps link and can reply when on the way.</p>
          </div>
          <button onclick="openDispatchModal()" class="bg-violet-600 hover:bg-violet-700 text-white text-sm font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 shadow-sm transition-colors">
            <i class="fas fa-paper-plane"></i> Dispatch a Job
          </button>
        </div>

        <!-- Stats row -->
        <div id="dispatch-stats-row" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <div class="bg-violet-50 rounded-xl p-3 text-center">
            <p class="text-2xl font-black text-violet-600" id="dstat-sent">—</p>
            <p class="text-[11px] text-gray-500 font-semibold mt-0.5">Sent (7d)</p>
          </div>
          <div class="bg-sky-50 rounded-xl p-3 text-center">
            <p class="text-2xl font-black text-sky-600" id="dstat-replied">—</p>
            <p class="text-[11px] text-gray-500 font-semibold mt-0.5">Replied</p>
          </div>
          <div class="bg-emerald-50 rounded-xl p-3 text-center">
            <p class="text-2xl font-black text-emerald-600" id="dstat-arrived">—</p>
            <p class="text-[11px] text-gray-500 font-semibold mt-0.5">Arrived</p>
          </div>
          <div class="bg-amber-50 rounded-xl p-3 text-center">
            <p class="text-2xl font-black text-amber-600" id="dstat-total">—</p>
            <p class="text-[11px] text-gray-500 font-semibold mt-0.5">Total (7d)</p>
          </div>
        </div>
      </div>

      <!-- Live Dispatch Board -->
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center justify-between mb-4">
          <h4 class="font-bold text-gray-700 flex items-center gap-2">
            <i class="fas fa-list-ul text-violet-400"></i> Recent Dispatches
          </h4>
          <button onclick="loadDispatchTab()" class="text-xs text-gray-400 hover:text-violet-600 flex items-center gap-1 transition-colors">
            <i class="fas fa-sync-alt text-[10px]"></i>Refresh
          </button>
        </div>
        <div id="dispatch-list" class="space-y-3">
          <p class="text-gray-400 text-sm text-center py-8">
            <i class="fas fa-paper-plane text-3xl block text-gray-200 mb-3"></i>
            No dispatches yet. Click "Dispatch a Job" to send the first one.
          </p>
        </div>
      </div>
    </div>

    <!-- ── Tab: Encircle Integration ──────────────────────────────────────── -->
    <div id="tab-encircle" class="tab-content hidden space-y-4">

      <!-- Header bar -->
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div class="flex items-center gap-3">
            <div class="w-11 h-11 bg-sky-100 rounded-xl flex items-center justify-center flex-shrink-0">
              <i class="fas fa-sync-alt text-sky-600 text-lg"></i>
            </div>
            <div>
              <h3 class="text-base font-bold text-gray-800 flex items-center gap-2">
                Encircle Integration
                <span id="encircle-connected-pill" class="hidden text-[11px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">● Connected</span>
              </h3>
              <p id="encircle-status-sub" class="text-xs text-gray-400 mt-0.5">Enter your bearer token below to connect</p>
            </div>
          </div>
          <!-- Actions (visible when connected) -->
          <div id="encircle-connected-actions" class="hidden items-center gap-2 flex-wrap">
            <div class="text-center bg-sky-50 rounded-xl px-3 py-1.5">
              <p class="text-lg font-bold text-sky-700" id="encircle-job-count-num">0</p>
              <p class="text-[10px] text-sky-500 font-medium">Active Jobs</p>
            </div>
            <button onclick="encircleSync()" id="encircle-sync-btn"
              class="bg-sky-600 hover:bg-sky-700 text-white text-sm font-bold px-4 py-2 rounded-xl flex items-center gap-2 shadow-sm transition-colors">
              <i class="fas fa-sync-alt"></i> Sync Now
            </button>
            <button onclick="encircleDisconnect()"
              class="bg-gray-100 hover:bg-red-50 hover:text-red-600 text-gray-600 text-sm font-medium px-3 py-2 rounded-xl flex items-center gap-1.5 transition-colors">
              <i class="fas fa-unlink text-xs"></i> Disconnect
            </button>
          </div>
        </div>
        <!-- Encircle API limitation notice -->
        <div class="mx-1 mb-3 flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <i class="fas fa-exclamation-triangle text-amber-500 text-sm mt-0.5 flex-shrink-0"></i>
          <div>
            <p class="text-xs font-bold text-amber-700">Encircle API does not send job status</p>
            <p class="text-xs text-amber-600 mt-0.5 leading-relaxed">
              Closing or leaving a job in Encircle does <strong>not</strong> remove it from CIP sync —
              Encircle's API returns all jobs with no status field.
              To remove a job from CIP, use the <strong>Close Job</strong> button on the card below.
              CIP will permanently ignore it on all future syncs.
            </p>
          </div>
        </div>
        <p id="encircle-last-sync" class="hidden text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">
          <i class="fas fa-clock mr-1"></i> Last synced: <span id="encircle-last-sync-time"></span>
        </p>
      </div>

      <!-- Setup form (hidden when connected) -->
      <div id="encircle-setup-card" class="bg-white rounded-2xl shadow-sm p-5">
        <h4 class="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
          <i class="fas fa-key text-amber-500"></i> Connect Your Encircle Account
        </h4>
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-xs text-amber-800">
          <p class="font-semibold mb-1">How to get your Bearer Token:</p>
          <ol class="list-decimal list-inside space-y-1 leading-relaxed">
            <li>Log in to <a href="https://encircleapp.com" target="_blank" class="underline font-medium">encircleapp.com</a></li>
            <li>Go to <strong>Settings → Integrations → API</strong></li>
            <li>Copy your Bearer Token and paste it below</li>
          </ol>
        </div>
        <div class="space-y-3 max-w-md">
          <div>
            <label class="text-xs font-semibold text-gray-600 block mb-1">Bearer Token</label>
            <input id="encircle-token-input" type="password"
              placeholder="e.g. b47b6ad0-3110-4561-9810-cb529b6e1106"
              class="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 font-mono bg-gray-50" />
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" id="encircle-sync-enabled" checked class="rounded text-sky-600" />
            <label for="encircle-sync-enabled" class="text-xs text-gray-600">Auto-sync every 30 minutes</label>
          </div>
          <button onclick="encircleConnect()" id="encircle-connect-btn"
            class="bg-sky-600 hover:bg-sky-700 text-white text-sm font-bold py-2.5 px-5 rounded-xl flex items-center gap-2 shadow-sm transition-colors">
            <i class="fas fa-link"></i> Connect to Encircle
          </button>
        </div>
      </div>

      <!-- Search + filter bar (visible when connected) -->
      <div id="encircle-filter-bar" class="hidden bg-white rounded-2xl shadow-sm p-4 flex flex-col sm:flex-row gap-3 items-center flex-wrap">
        <div class="relative flex-1 w-full min-w-[180px]">
          <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
          <input id="encircle-search" type="text" placeholder="Search by name, address, phone, PM..."
            oninput="filterEncircleJobs()"
            class="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-sky-300 focus:border-sky-400 bg-gray-50" />
        </div>
        <select id="encircle-filter-type" onchange="filterEncircleJobs()"
          class="px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 bg-gray-50 focus:ring-2 focus:ring-sky-300">
          <option value="">All Types</option>
          <option value="Water">Water</option>
          <option value="Fire">Fire</option>
          <option value="Mold">Mold</option>
          <option value="Wind">Wind / Hail</option>
        </select>
        <select id="encircle-filter-pm" onchange="filterEncircleJobs()"
          class="px-3 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 bg-gray-50 focus:ring-2 focus:ring-sky-300">
          <option value="">All Project Managers</option>
        </select>
        <!-- Show closed toggle -->
        <label class="flex items-center gap-2 cursor-pointer select-none shrink-0 px-1">
          <input id="encircle-show-closed" type="checkbox" onchange="filterEncircleJobs()"
            class="w-4 h-4 rounded accent-amber-500 cursor-pointer" />
          <span class="text-xs text-gray-500 font-medium">Show closed</span>
        </label>
      </div>

      <!-- Job cards grid -->
      <div id="encircle-jobs-grid" class="hidden space-y-3">
        <p class="text-xs text-gray-400 font-medium px-1" id="encircle-showing-count"></p>
        <div id="encircle-cards-container" class="space-y-3"></div>
        <p id="encircle-jobs-empty" class="hidden text-gray-400 text-sm text-center py-10 bg-white rounded-2xl">
          <i class="fas fa-inbox text-3xl block mb-3 text-gray-300"></i>
          No active jobs found. <span class="text-amber-600 cursor-pointer underline" onclick="document.getElementById('encircle-show-closed').checked=true;filterEncircleJobs()">Show closed jobs</span> or click <strong>Sync Now</strong> to import from Encircle.
        </p>
      </div>

      <!-- Sync History Log (collapsible) -->
      <div id="encircle-log-card" class="bg-white rounded-2xl shadow-sm hidden">
        <button onclick="toggleEncircleLog()" class="w-full flex items-center justify-between p-4 text-sm font-semibold text-gray-600 hover:text-gray-800 transition-colors">
          <span class="flex items-center gap-2"><i class="fas fa-history text-gray-400"></i> Sync History</span>
          <i class="fas fa-chevron-down text-gray-400 transition-transform" id="encircle-log-chevron"></i>
        </button>
        <div id="encircle-log-body" class="hidden border-t border-gray-100">
          <div class="overflow-x-auto p-4">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-gray-100">
                  <th class="text-left py-2 text-gray-500 font-semibold">Date / Time</th>
                  <th class="text-center py-2 px-2 text-gray-500 font-semibold">Added</th>
                  <th class="text-center py-2 px-2 text-gray-500 font-semibold">Updated</th>
                  <th class="text-center py-2 px-2 text-gray-500 font-semibold">Closed</th>
                  <th class="text-left py-2 px-2 text-gray-500 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody id="encircle-log-tbody" class="divide-y divide-gray-50"></tbody>
            </table>
          </div>
          <p id="encircle-log-empty" class="hidden text-gray-400 text-sm text-center py-6">No sync history yet.</p>
        </div>
      </div>

    </div>

    <!-- ── Tab: Issue Reports (Disputes) ───────────────────────────────────── -->
    <div id="tab-disputes" class="tab-content hidden bg-white rounded-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-5">
        <div>
          <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-flag text-rose-500 mr-2"></i>Worker Issue Reports</h3>
          <p class="text-xs text-gray-500 mt-0.5">Workers can flag sessions they believe are wrong. Review and respond here.</p>
        </div>
        <span id="disputes-count-badge" class="bg-rose-100 text-rose-700 text-sm font-bold px-3 py-1 rounded-full"></span>
      </div>
      <div id="disputes-list" class="space-y-4">
        <p class="text-gray-400 text-sm text-center py-8"><i class="fas fa-check-circle text-green-400 text-3xl mb-3 block"></i>No issue reports yet.</p>
      </div>
      <div class="mt-6 border-t pt-4">
        <button onclick="loadDisputeHistory()" class="text-xs text-gray-500 hover:text-gray-700 underline">View resolved reports</button>
        <div id="disputes-history" class="hidden mt-3 space-y-2"></div>
      </div>
    </div>

    <!-- ── Tab: Support Tickets ──────────────────────────────────────────── -->
    <div id="tab-support-tickets" class="tab-content hidden">

      <!-- Submit new ticket card -->
      <div class="bg-white rounded-2xl shadow-sm p-5 mb-6">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-life-ring text-indigo-600 text-lg"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-gray-800">Submit a Support Request</h3>
            <p class="text-xs text-gray-500">We typically respond within 24 hours. You'll receive email updates on your ticket.</p>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Subject *</label>
            <input id="tkt-subject" type="text" placeholder="Brief description of your issue"
              class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Category</label>
            <select id="tkt-category" class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <option value="general">General Question</option>
              <option value="billing">Billing / Subscription</option>
              <option value="technical">Technical Issue</option>
              <option value="feature">Feature Request</option>
              <option value="account">Account / Access</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Priority</label>
            <select id="tkt-priority" class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent — system is down</option>
              <option value="low">Low — no rush</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Your Name / Email (optional)</label>
            <input id="tkt-submitter" type="text" placeholder="e.g. Jane Smith / jane@company.com"
              class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"/>
          </div>
          <div class="md:col-span-2">
            <label class="block text-xs font-semibold text-gray-600 mb-1">Description *</label>
            <textarea id="tkt-description" rows="4" placeholder="Please describe your issue in detail — include steps to reproduce if applicable..."
              class="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"></textarea>
          </div>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button onclick="submitTenantTicket()" id="tkt-submit-btn"
            class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2">
            <i class="fas fa-paper-plane"></i> Submit Ticket
          </button>
          <span id="tkt-submit-msg" class="text-sm"></span>
        </div>
      </div>

      <!-- My tickets list -->
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-base font-bold text-gray-800"><i class="fas fa-ticket-alt text-indigo-500 mr-2"></i>My Support Tickets</h3>
          <button onclick="loadTenantTickets()" class="text-xs text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1">
            <i class="fas fa-rotate-right text-xs"></i> Refresh
          </button>
        </div>
        <div id="tenant-tickets-list">
          <div class="text-center py-10 text-gray-400">
            <i class="fas fa-spinner fa-spin text-2xl mb-3 block"></i>
            <p class="text-sm">Loading tickets...</p>
          </div>
        </div>
      </div>

    </div><!-- /tab-support-tickets -->

    </main><!-- /main content -->
  </div><!-- /flex body -->
</div><!-- /admin-dashboard -->

<!-- ── Job Dispatch Modal ──────────────────────────────────────────────────── -->
<div id="dispatch-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 z-[90] flex items-start justify-center p-4 overflow-y-auto" onclick="if(event.target===this)closeDispatchModal()">
  <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-6 overflow-hidden">
    <!-- Header -->
    <div class="bg-gradient-to-r from-violet-600 to-indigo-600 px-6 py-5 text-white flex items-start justify-between gap-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <i class="fas fa-paper-plane text-violet-200"></i>
          <span class="text-violet-200 text-xs font-semibold uppercase tracking-wide">Job Dispatch</span>
        </div>
        <h2 class="text-xl font-bold">Send Job to Worker</h2>
        <p class="text-violet-200 text-sm mt-0.5">Worker receives an SMS with address &amp; Google Maps link</p>
      </div>
      <button onclick="closeDispatchModal()" class="w-9 h-9 flex items-center justify-center rounded-xl bg-white bg-opacity-20 hover:bg-opacity-30 text-white flex-shrink-0">
        <i class="fas fa-times"></i>
      </button>
    </div>

    <!-- Body -->
    <div class="p-6 space-y-4">

      <!-- Job Source toggle -->
      <div>
        <p class="text-xs font-bold text-gray-600 mb-2 uppercase tracking-wide">Job Source</p>
        <div class="flex gap-2">
          <button id="dsrc-encircle-btn" onclick="setDispatchSource('encircle')"
            class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border-2 border-sky-400 bg-sky-50 text-sky-700 transition-colors">
            <i class="fas fa-sync-alt mr-1"></i>Encircle Job
          </button>
          <button id="dsrc-manual-btn" onclick="setDispatchSource('manual')"
            class="flex-1 text-xs font-semibold py-2 px-3 rounded-xl border-2 border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-colors">
            <i class="fas fa-keyboard mr-1"></i>Manual Entry
          </button>
        </div>
      </div>

      <!-- Encircle job picker (default) -->
      <div id="dsrc-encircle">
        <label class="block text-xs font-bold text-gray-600 mb-1.5">Select Encircle Job</label>
        <select id="dispatch-encircle-select"
          class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-violet-500 transition-colors"
          onchange="onDispatchEncircleSelect(this.value)">
          <option value="">— Loading jobs… —</option>
        </select>
      </div>

      <!-- Manual entry (hidden by default) -->
      <div id="dsrc-manual" class="hidden space-y-3">
        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5">Job Name / Description <span class="text-red-500">*</span></label>
          <input id="dispatch-manual-name" type="text" placeholder="e.g. Water damage restoration"
            class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-violet-500 transition-colors"/>
        </div>
        <div>
          <label class="block text-xs font-bold text-gray-600 mb-1.5">Address <span class="text-red-500">*</span></label>
          <input id="dispatch-manual-address" type="text" placeholder="Full property address"
            class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-violet-500 transition-colors"/>
        </div>
      </div>

      <!-- Job preview card (shown after selection) -->
      <div id="dispatch-job-preview" class="hidden bg-gray-50 rounded-xl p-3 border border-gray-200">
        <p class="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">Job Preview</p>
        <p id="dispatch-preview-name" class="font-bold text-gray-800 text-sm"></p>
        <p id="dispatch-preview-address" class="text-xs text-gray-600 mt-0.5"></p>
        <a id="dispatch-preview-map" href="#" target="_blank"
           class="inline-flex items-center gap-1 text-[11px] text-sky-500 hover:underline mt-1">
          <i class="fas fa-map-marked-alt text-[10px]"></i>Preview in Google Maps
        </a>
      </div>

      <!-- Worker picker -->
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1.5">Select Worker <span class="text-red-500">*</span></label>
        <select id="dispatch-worker-select"
          class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-violet-500 transition-colors">
          <option value="">— Loading workers… —</option>
        </select>
        <p id="dispatch-worker-phone-preview" class="text-[11px] text-gray-400 mt-1 hidden">
          <i class="fas fa-mobile-alt mr-1"></i><span id="dispatch-worker-phone-val"></span>
        </p>
      </div>

      <!-- Optional notes -->
      <div>
        <label class="block text-xs font-bold text-gray-600 mb-1.5">Note to Worker <span class="text-gray-400 font-normal">(optional)</span></label>
        <input id="dispatch-notes" type="text" placeholder="e.g. Bring dehumidifier. Client name: John."
          class="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-violet-500 transition-colors"/>
      </div>

      <!-- SMS Preview -->
      <div class="bg-gray-900 rounded-xl p-4">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <i class="fas fa-comment-dots text-green-400"></i>SMS Preview
        </p>
        <pre id="dispatch-sms-preview" class="text-xs text-green-300 font-mono whitespace-pre-wrap leading-relaxed">Select a job and worker to preview the SMS…</pre>
      </div>
    </div>

    <!-- Footer -->
    <div class="border-t border-gray-100 px-6 py-4 flex gap-3 bg-gray-50">
      <button onclick="closeDispatchModal()"
        class="flex-1 bg-white border-2 border-gray-200 hover:border-gray-400 text-gray-700 font-semibold py-3 rounded-xl text-sm transition-colors">
        Cancel
      </button>
      <button id="dispatch-send-btn" onclick="sendDispatch()"
        class="flex-1 bg-violet-600 hover:bg-violet-700 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2 shadow-sm transition-colors">
        <i class="fas fa-paper-plane"></i>Send via SMS
      </button>
    </div>
  </div>
</div>

<!-- ── Add / Edit Job Site Modal ─────────────────────────────────────────── -->
<div id="site-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" onclick="if(event.target===this)closeSiteModal()">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
    <div class="flex items-center justify-between mb-5">
      <h3 id="site-modal-title" class="text-lg font-bold text-gray-800">Add Job Site</h3>
      <button onclick="closeSiteModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
    </div>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Site Name *</label>
        <input id="site-name" type="text" placeholder="e.g. Downtown Office, Warehouse A"
          class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Address *</label>
        <input id="site-address" type="text" placeholder="Start typing an address..."
          autocomplete="off"
          class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
          oninput="filterSiteAddressSuggestions(this.value)"
          onblur="setTimeout(()=>document.getElementById('site-address-suggestions').classList.add('hidden'),200)"/>
        <div id="site-address-suggestions" class="hidden mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-50 max-h-48 overflow-y-auto"></div>
        <p class="text-xs text-gray-400 mt-1">Pick from suggestions for precise GPS geofence matching.</p>
      </div>
    </div>
    <div class="flex gap-3 mt-6">
      <button onclick="closeSiteModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl">Cancel</button>
      <button id="site-save-btn" onclick="saveSite()" class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-xl">
        <i class="fas fa-save mr-1.5"></i>Save Site
      </button>
    </div>
  </div>
</div>

<!-- Add Worker Modal -->
<div id="add-worker-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-50">
  <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
    <!-- Header -->
    <div class="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between rounded-t-2xl z-10">
      <div>
        <h3 class="text-lg font-bold text-gray-800">Add New Worker</h3>
        <p class="text-xs text-gray-400 mt-0.5">Fill in the worker's profile information</p>
      </div>
      <button onclick="closeModal()" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600">
        <i class="fas fa-times text-lg"></i>
      </button>
    </div>

    <div class="p-6 space-y-6">

      <!-- Section: Identity -->
      <div>
        <h4 class="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-user-circle"></i> Basic Info
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">Full Name <span class="text-red-500">*</span></label>
            <input id="modal-name" type="text" placeholder="e.g. John Smith"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Phone Number <span class="text-red-500">*</span></label>
            <input id="modal-phone" type="tel" placeholder="+1 613 555 0100"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
            <input id="modal-email" type="email" placeholder="worker@email.com"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">Home Address</label>
            <input id="modal-address" type="text" placeholder="123 Main St, Ottawa, ON K1A 0A1"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Emergency Contact</label>
            <input id="modal-emergency" type="text" placeholder="Jane Smith +1 613 555 0199"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Worker PIN</label>
            <input id="modal-pin" type="text" placeholder="0000" maxlength="6"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
        </div>
      </div>

      <!-- Section: Employment -->
      <div>
        <h4 class="text-xs font-bold text-emerald-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-briefcase"></i> Employment
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Job Title</label>
            <input id="modal-job-title" type="text" placeholder="e.g. Electrician, Labourer"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input id="modal-start-date" type="date"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Pay Type</label>
            <select id="modal-pay-type" onchange="togglePayType()"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm">
              <option value="hourly">Hourly Rate</option>
              <option value="salary">Annual Salary</option>
            </select>
          </div>
          <div id="modal-hourly-block">
            <label class="block text-sm font-medium text-gray-700 mb-1">Hourly Rate ($/hr)</label>
            <input id="modal-rate" type="number" placeholder="18.00" step="0.50" min="0"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div id="modal-salary-block" class="hidden">
            <label class="block text-sm font-medium text-gray-700 mb-1">Annual Salary ($)</label>
            <input id="modal-salary" type="number" placeholder="55000" step="500" min="0"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
        </div>
      </div>

      <!-- Section: Driver's License -->
      <div>
        <h4 class="text-xs font-bold text-amber-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-id-card"></i> Driver's License
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">License Number</label>
            <input id="modal-license-num" type="text" placeholder="A12345-67890-12345"
              class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-amber-500 text-sm"/>
          </div>
          <!-- Front photo -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">License — Front</label>
            <label for="modal-lic-front" class="block cursor-pointer">
              <div id="modal-lic-front-preview" class="w-full h-32 bg-amber-50 border-2 border-dashed border-amber-300 rounded-xl flex flex-col items-center justify-center hover:bg-amber-100 transition-colors">
                <i class="fas fa-camera text-amber-400 text-2xl mb-1"></i>
                <span class="text-xs text-amber-500 font-medium">Tap to upload front</span>
              </div>
            </label>
            <input type="file" id="modal-lic-front" accept="image/*" class="hidden" onchange="previewLicense(this,'modal-lic-front-preview','modal-lic-front-b64')"/>
            <input type="hidden" id="modal-lic-front-b64"/>
          </div>
          <!-- Back photo -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">License — Back</label>
            <label for="modal-lic-back" class="block cursor-pointer">
              <div id="modal-lic-back-preview" class="w-full h-32 bg-amber-50 border-2 border-dashed border-amber-300 rounded-xl flex flex-col items-center justify-center hover:bg-amber-100 transition-colors">
                <i class="fas fa-camera text-amber-400 text-2xl mb-1"></i>
                <span class="text-xs text-amber-500 font-medium">Tap to upload back</span>
              </div>
            </label>
            <input type="file" id="modal-lic-back" accept="image/*" class="hidden" onchange="previewLicense(this,'modal-lic-back-preview','modal-lic-back-b64')"/>
            <input type="hidden" id="modal-lic-back-b64"/>
          </div>
        </div>
      </div>

      <!-- Section: Notes -->
      <div>
        <h4 class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2">
          <i class="fas fa-sticky-note"></i> Notes
        </h4>
        <textarea id="modal-notes" rows="2" placeholder="Optional notes about this worker..."
          class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 text-sm resize-none"></textarea>
      </div>
    </div>

    <!-- Footer buttons -->
    <div class="sticky bottom-0 bg-white border-t px-6 py-4 flex gap-3 rounded-b-2xl">
      <button onclick="closeModal()" class="flex-1 border-2 border-gray-200 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50 text-sm">
        Cancel
      </button>
      <button onclick="addWorker()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2">
        <i class="fas fa-user-plus"></i> Add Worker
      </button>
    </div>
  </div>
</div>

<!-- Toast -->
<div id="admin-toast" class="hidden fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white"></div>

<!-- ── Worker Detail Drawer ─────────────────────────────────────────── -->
<div id="worker-drawer" class="hidden fixed inset-0 z-50 flex justify-end" onclick="if(event.target===this)closeWorkerDrawer()">
  <div class="absolute inset-0 bg-black bg-opacity-40 backdrop-blur-sm"></div>
  <div class="relative w-full max-w-md bg-white h-full overflow-y-auto shadow-2xl flex flex-col">
    <!-- Header -->
    <div class="sticky top-0 bg-white border-b px-5 py-4 flex items-center justify-between z-10">
      <div>
        <h2 id="wd-name" class="text-lg font-bold text-gray-800"></h2>
        <p id="wd-phone" class="text-sm text-gray-500"></p>
      </div>
      <button onclick="closeWorkerDrawer()" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-700">
        <i class="fas fa-times text-lg"></i>
      </button>
    </div>
    <!-- Stats strip -->
    <div class="grid grid-cols-3 gap-3 px-5 py-4 bg-gray-50 border-b">
      <div class="text-center">
        <p class="text-xl font-bold text-indigo-600" id="wd-total-sessions">–</p>
        <p class="text-xs text-gray-500 mt-0.5">Sessions</p>
      </div>
      <div class="text-center">
        <p class="text-xl font-bold text-yellow-600" id="wd-total-hours">–</p>
        <p class="text-xs text-gray-500 mt-0.5">Total Hours</p>
      </div>
      <div class="text-center">
        <p class="text-xl font-bold text-green-600" id="wd-total-earned">–</p>
        <p class="text-xs text-gray-500 mt-0.5">Total Earned</p>
      </div>
    </div>
    <!-- Info row -->
    <div class="px-5 py-3 border-b flex items-center gap-4 text-sm flex-wrap">
      <span id="wd-rate" class="text-green-600 font-bold"></span>
      <span id="wd-role" class="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full text-xs"></span>
      <span id="wd-status-badge"></span>
      <span id="wd-invite-badge"></span>
      <button id="wd-filter-sessions-btn" onclick="filterSessionsByWorker()" class="ml-auto text-xs text-indigo-600 hover:text-indigo-800 font-medium">
        <i class="fas fa-filter mr-1"></i>Filter Sessions Tab
      </button>
    </div>
    <!-- Force Clock-Out Action Bar (shown when worker is active) -->
    <div id="wd-action-bar" class="hidden px-5 py-3 border-b bg-red-50"></div>

    <!-- Tab navigation -->
    <div class="flex border-b bg-gray-50 px-5 pt-3 gap-1 overflow-x-auto">
      <button onclick="wdTab('sessions')" id="wdt-sessions"
        class="px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-indigo-500 text-indigo-600 bg-white whitespace-nowrap">
        <i class="fas fa-history mr-1"></i>Sessions
      </button>
      <button onclick="wdTab('profile')" id="wdt-profile"
        class="px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
        <i class="fas fa-id-badge mr-1"></i>Profile
      </button>
      <button onclick="wdTab('status')" id="wdt-status"
        class="px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
        <i class="fas fa-user-tag mr-1"></i>Status
      </button>
      <button onclick="wdTab('license')" id="wdt-license"
        class="px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap">
        <i class="fas fa-id-card mr-1"></i>License
      </button>
    </div>

    <!-- Sessions tab -->
    <div id="wd-tab-sessions" class="px-5 py-4 flex-1">
      <div id="wd-sessions" class="space-y-3">
        <p class="text-gray-400 text-sm text-center py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>
      </div>
    </div>

    <!-- Profile tab (hidden by default) -->
    <div id="wd-tab-profile" class="hidden px-5 py-4 flex-1 space-y-4">
      <!-- Edit button -->
      <div class="flex justify-end">
        <button onclick="openEditWorkerModal()" class="flex items-center gap-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold px-4 py-2 rounded-xl transition-colors">
          <i class="fas fa-edit"></i> Edit Profile
        </button>
      </div>
      <!-- Contact -->
      <div class="bg-gray-50 rounded-2xl p-4 space-y-3">
        <p class="text-xs font-bold text-gray-400 uppercase tracking-wider">Contact</p>
        <div class="grid grid-cols-1 gap-2">
          <div class="flex items-start gap-3">
            <i class="fas fa-phone text-indigo-400 mt-0.5 w-4 flex-shrink-0"></i>
            <div><p class="text-xs text-gray-400">Phone</p><p class="text-sm font-semibold text-gray-700" id="wd-p-phone">–</p></div>
          </div>
          <div class="flex items-start gap-3">
            <i class="fas fa-envelope text-indigo-400 mt-0.5 w-4 flex-shrink-0"></i>
            <div><p class="text-xs text-gray-400">Email</p><p class="text-sm font-semibold text-gray-700" id="wd-p-email">–</p></div>
          </div>
          <div class="flex items-start gap-3">
            <i class="fas fa-home text-indigo-400 mt-0.5 w-4 flex-shrink-0"></i>
            <div><p class="text-xs text-gray-400">Home Address</p><p class="text-sm font-semibold text-gray-700" id="wd-p-address">–</p></div>
          </div>
          <div class="flex items-start gap-3">
            <i class="fas fa-heart text-red-400 mt-0.5 w-4 flex-shrink-0"></i>
            <div><p class="text-xs text-gray-400">Emergency Contact</p><p class="text-sm font-semibold text-gray-700" id="wd-p-emergency">–</p></div>
          </div>
        </div>
      </div>
      <!-- Employment -->
      <div class="bg-emerald-50 rounded-2xl p-4 space-y-3">
        <p class="text-xs font-bold text-emerald-600 uppercase tracking-wider">Employment</p>
        <div class="grid grid-cols-2 gap-3">
          <div><p class="text-xs text-gray-400">Job Title</p><p class="text-sm font-semibold text-gray-700" id="wd-p-title">–</p></div>
          <div><p class="text-xs text-gray-400">Start Date</p><p class="text-sm font-semibold text-gray-700" id="wd-p-start">–</p></div>
          <div><p class="text-xs text-gray-400">Pay Type</p><p class="text-sm font-semibold text-gray-700" id="wd-p-paytype">–</p></div>
          <div><p class="text-xs text-gray-400">Compensation</p><p class="text-sm font-bold text-emerald-700" id="wd-p-comp">–</p></div>
        </div>
      </div>
      <!-- Notes -->
      <div id="wd-p-notes-block" class="hidden bg-yellow-50 rounded-2xl p-4">
        <p class="text-xs font-bold text-yellow-600 uppercase tracking-wider mb-2">Notes</p>
        <p class="text-sm text-gray-700" id="wd-p-notes">–</p>
      </div>
    </div>

    <!-- Status tab (hidden by default) -->
    <div id="wd-tab-status" class="hidden px-5 py-4 flex-1 space-y-4">

      <!-- Current status card -->
      <div class="bg-white border-2 border-gray-200 rounded-2xl p-4" id="wd-s-current-card">
        <div class="flex items-center justify-between mb-3">
          <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">Current Status</p>
          <span id="wd-s-current-badge" class="text-xs px-3 py-1 rounded-full font-bold">–</span>
        </div>
        <p class="text-sm text-gray-600" id="wd-s-since">–</p>
      </div>

      <!-- Change status form -->
      <div class="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 space-y-3">
        <p class="text-xs font-bold text-indigo-700 uppercase tracking-wider flex items-center gap-2">
          <i class="fas fa-exchange-alt"></i> Change Employment Status
        </p>

        <!-- Status selector -->
        <div>
          <label class="text-xs text-gray-600 font-semibold block mb-1.5">New Status <span class="text-red-500">*</span></label>
          <div class="grid grid-cols-1 gap-2" id="wd-s-options">
            <button onclick="selectWorkerStatus('active')" id="wds-active"
              class="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-green-400 hover:bg-green-50 transition-all text-left">
              <span class="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-check-circle text-green-600"></i>
              </span>
              <div>
                <p class="text-sm font-bold text-gray-800">Active</p>
                <p class="text-xs text-gray-400">Working normally</p>
              </div>
            </button>
            <button onclick="selectWorkerStatus('on_holiday')" id="wds-on_holiday"
              class="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50 transition-all text-left">
              <span class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-umbrella-beach text-blue-600"></i>
              </span>
              <div>
                <p class="text-sm font-bold text-gray-800">On Holiday</p>
                <p class="text-xs text-gray-400">Approved vacation / time off</p>
              </div>
            </button>
            <button onclick="selectWorkerStatus('sick_leave')" id="wds-sick_leave"
              class="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-yellow-400 hover:bg-yellow-50 transition-all text-left">
              <span class="w-8 h-8 rounded-full bg-yellow-100 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-thermometer-half text-yellow-600"></i>
              </span>
              <div>
                <p class="text-sm font-bold text-gray-800">Sick Leave</p>
                <p class="text-xs text-gray-400">Medical / illness absence</p>
              </div>
            </button>
            <button onclick="selectWorkerStatus('suspended')" id="wds-suspended"
              class="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-orange-400 hover:bg-orange-50 transition-all text-left">
              <span class="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-pause-circle text-orange-600"></i>
              </span>
              <div>
                <p class="text-sm font-bold text-gray-800">Suspended</p>
                <p class="text-xs text-gray-400">Temporarily removed from work — clocks out immediately</p>
              </div>
            </button>
            <button onclick="selectWorkerStatus('terminated')" id="wds-terminated"
              class="flex items-center gap-3 p-3 rounded-xl border-2 border-gray-200 bg-white hover:border-red-400 hover:bg-red-50 transition-all text-left">
              <span class="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-user-slash text-red-600"></i>
              </span>
              <div>
                <p class="text-sm font-bold text-gray-800">Terminated</p>
                <p class="text-xs text-gray-400">Employment ended — access revoked immediately</p>
              </div>
            </button>
          </div>
        </div>

        <!-- Reason field -->
        <div>
          <label class="text-xs text-gray-600 font-semibold block mb-1.5">Reason <span class="text-red-500">*</span></label>
          <textarea id="wd-s-reason" rows="2" placeholder="Enter reason for status change..."
            class="w-full border-2 border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 resize-none bg-white transition-colors"></textarea>
          <p id="wd-s-reason-error" class="hidden text-xs text-red-500 mt-1"><i class="fas fa-exclamation-circle mr-1"></i>Reason is required.</p>
        </div>

        <!-- Expected return date (shown for holiday / sick leave) -->
        <div id="wd-s-return-wrap" class="hidden">
          <label class="text-xs text-gray-600 font-semibold block mb-1.5">Expected Return Date <span class="text-gray-400 font-normal">(optional)</span></label>
          <input type="date" id="wd-s-return-date"
            class="w-full border-2 border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-400 bg-white transition-colors"/>
        </div>

        <!-- Submit button -->
        <button onclick="confirmWorkerStatusChange()" id="wd-s-submit-btn"
          class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl transition-colors shadow-sm disabled:opacity-50">
          <i class="fas fa-save mr-1.5"></i>Save Status Change
        </button>
      </div>

      <!-- Audit trail -->
      <div>
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-history text-gray-400"></i> Audit Trail
        </p>
        <div id="wd-s-log" class="space-y-2">
          <p class="text-gray-400 text-sm text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>
        </div>
      </div>
    </div>

    <!-- License tab (hidden by default) -->
    <div id="wd-tab-license" class="hidden px-5 py-4 flex-1 space-y-4">
      <div class="bg-amber-50 rounded-2xl p-4 space-y-3">
        <p class="text-xs font-bold text-amber-600 uppercase tracking-wider">Driver's License</p>
        <div class="flex items-center gap-3">
          <i class="fas fa-id-card text-amber-500 text-2xl"></i>
          <div>
            <p class="text-xs text-gray-400">License Number</p>
            <p class="text-sm font-bold text-gray-800" id="wd-l-number">–</p>
          </div>
        </div>
      </div>
      <!-- Front image -->
      <div>
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">License Front</p>
        <div id="wd-l-front" class="w-full bg-gray-100 rounded-2xl overflow-hidden min-h-[120px] flex items-center justify-center">
          <p class="text-gray-300 text-sm"><i class="fas fa-image mr-1"></i>No image</p>
        </div>
      </div>
      <!-- Back image -->
      <div>
        <p class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">License Back</p>
        <div id="wd-l-back" class="w-full bg-gray-100 rounded-2xl overflow-hidden min-h-[120px] flex items-center justify-center">
          <p class="text-gray-300 text-sm"><i class="fas fa-image mr-1"></i>No image</p>
        </div>
      </div>
      <!-- Update license photos button -->
      <div class="pt-2">
        <button onclick="openEditWorkerModal('license')" class="w-full flex items-center justify-center gap-2 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 font-bold py-3 px-4 rounded-2xl text-sm transition-colors">
          <i class="fas fa-camera"></i> Update License Photos
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── Edit Worker Modal ─────────────────────────────────────────────────── -->
<div id="edit-worker-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center p-4 z-[60]">
  <div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
    <div class="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between rounded-t-2xl z-10">
      <div>
        <h3 class="text-lg font-bold text-gray-800">Edit Worker</h3>
        <p class="text-xs text-gray-400 mt-0.5" id="ew-subtitle">Update worker information</p>
      </div>
      <button onclick="closeEditWorkerModal()" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600">
        <i class="fas fa-times text-lg"></i>
      </button>
    </div>
    <input type="hidden" id="ew-worker-id"/>
    <div class="p-6 space-y-6">
      <!-- Basic Info -->
      <div>
        <h4 class="text-xs font-bold text-indigo-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-user-circle"></i> Basic Info
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
            <input id="ew-name" type="text" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input id="ew-phone" type="tel" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm bg-gray-50" readonly/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input id="ew-email" type="email" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">Home Address</label>
            <input id="ew-address" type="text" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Emergency Contact</label>
            <input id="ew-emergency" type="text" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">PIN</label>
            <input id="ew-pin" type="text" maxlength="6" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-indigo-500 text-sm"/>
          </div>
        </div>
      </div>
      <!-- Employment -->
      <div>
        <h4 class="text-xs font-bold text-emerald-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-briefcase"></i> Employment
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Job Title</label>
            <input id="ew-job-title" type="text" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input id="ew-start-date" type="date" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Pay Type</label>
            <select id="ew-pay-type" onchange="toggleEwPayType()" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm">
              <option value="hourly">Hourly Rate</option>
              <option value="salary">Annual Salary</option>
            </select>
          </div>
          <div id="ew-hourly-block">
            <label class="block text-sm font-medium text-gray-700 mb-1">Hourly Rate ($/hr)</label>
            <input id="ew-rate" type="number" step="0.50" min="0" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div id="ew-salary-block" class="hidden">
            <label class="block text-sm font-medium text-gray-700 mb-1">Annual Salary ($)</label>
            <input id="ew-salary" type="number" step="500" min="0" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select id="ew-active" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm">
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </select>
          </div>
        </div>
      </div>
      <!-- License -->
      <div>
        <h4 class="text-xs font-bold text-amber-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-id-card"></i> Driver's License
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="sm:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">License Number</label>
            <input id="ew-license-num" type="text" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-amber-500 text-sm"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Front Photo</label>
            <label for="ew-lic-front" class="block cursor-pointer">
              <div id="ew-lic-front-preview" class="w-full h-28 bg-amber-50 border-2 border-dashed border-amber-300 rounded-xl flex flex-col items-center justify-center hover:bg-amber-100 transition-colors overflow-hidden">
                <i class="fas fa-camera text-amber-400 text-xl mb-1"></i>
                <span class="text-xs text-amber-500">Tap to change</span>
              </div>
            </label>
            <input type="file" id="ew-lic-front" accept="image/*" class="hidden" onchange="previewLicense(this,'ew-lic-front-preview','ew-lic-front-b64')"/>
            <input type="hidden" id="ew-lic-front-b64"/>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Back Photo</label>
            <label for="ew-lic-back" class="block cursor-pointer">
              <div id="ew-lic-back-preview" class="w-full h-28 bg-amber-50 border-2 border-dashed border-amber-300 rounded-xl flex flex-col items-center justify-center hover:bg-amber-100 transition-colors overflow-hidden">
                <i class="fas fa-camera text-amber-400 text-xl mb-1"></i>
                <span class="text-xs text-amber-500">Tap to change</span>
              </div>
            </label>
            <input type="file" id="ew-lic-back" accept="image/*" class="hidden" onchange="previewLicense(this,'ew-lic-back-preview','ew-lic-back-b64')"/>
            <input type="hidden" id="ew-lic-back-b64"/>
          </div>
        </div>
      </div>
      <!-- Notes -->
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Notes</label>
        <textarea id="ew-notes" rows="2" class="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-gray-400 text-sm resize-none"></textarea>
      </div>

      <!-- Device Security -->
      <div>
        <h4 class="text-xs font-bold text-rose-600 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="fas fa-mobile-alt"></i> Device Security
        </h4>
        <div id="ew-device-status" class="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-3">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" id="ew-device-icon-bg">
              <i class="fas fa-mobile-alt text-sm" id="ew-device-icon"></i>
            </div>
            <div class="flex-1">
              <p class="text-sm font-semibold text-gray-800" id="ew-device-label">Loading...</p>
              <p class="text-xs text-gray-500 mt-0.5" id="ew-device-sub"></p>
            </div>
          </div>
        </div>
        <button onclick="adminResetWorkerDevice()" id="ew-reset-device-btn"
          class="w-full border-2 border-rose-200 text-rose-600 hover:bg-rose-50 font-semibold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors">
          <i class="fas fa-rotate-right"></i> Reset Device Lock
        </button>
        <p class="text-xs text-gray-400 mt-2 text-center">Only reset if you have <strong>personally verified</strong> the worker has a new phone.</p>
      </div>

    </div>
    <div class="sticky bottom-0 bg-white border-t px-6 py-4 flex gap-3 rounded-b-2xl">
      <button onclick="closeEditWorkerModal()" class="flex-1 border-2 border-gray-200 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50 text-sm">Cancel</button>
      <button onclick="saveEditWorker()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center gap-2">
        <i class="fas fa-save"></i> Save Changes
      </button>
    </div>
  </div>
</div>

<!-- ── Session Detail Modal ────────────────────────────────────────── -->
<div id="session-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" onclick="if(event.target===this)closeSessionModal()">
  <div class="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
    <!-- Header -->
    <div class="bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-5 flex items-start justify-between">
      <div>
        <h2 id="sm-worker-name" class="text-white text-lg font-bold"></h2>
        <p id="sm-date" class="text-indigo-200 text-sm mt-0.5"></p>
      </div>
      <button onclick="closeSessionModal()" class="text-white opacity-70 hover:opacity-100 mt-0.5">
        <i class="fas fa-times text-xl"></i>
      </button>
    </div>
    <!-- Body -->
    <div id="sm-body" class="p-6 space-y-4 max-h-[70vh] overflow-y-auto"></div>
  </div>
</div>

<!-- ── Session Edit Modal ──────────────────────────────────────────────── -->
<div id="session-edit-modal" class="hidden fixed inset-0 z-[70] flex items-center justify-center p-4" onclick="if(event.target===this)closeSessionEditModal()">
  <div class="absolute inset-0 bg-black bg-opacity-60 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
    <div class="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-5 text-center">
      <div class="w-12 h-12 bg-white bg-opacity-20 rounded-full flex items-center justify-center mx-auto mb-2">
        <i class="fas fa-edit text-white text-xl"></i>
      </div>
      <h2 class="text-white text-lg font-bold">Edit Session Times</h2>
      <p id="sem-worker-label" class="text-amber-100 text-sm mt-0.5"></p>
    </div>
    <div class="p-6 space-y-4">
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
        <i class="fas fa-exclamation-triangle mr-1"></i>
        All edits are logged in the audit trail with your reason.
      </div>
      <div>
        <label class="text-xs font-semibold text-gray-600 block mb-1.5"><i class="fas fa-sign-in-alt mr-1 text-green-500"></i>Clock In Time</label>
        <input id="sem-clock-in" type="datetime-local" class="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
      </div>
      <div>
        <label class="text-xs font-semibold text-gray-600 block mb-1.5"><i class="fas fa-sign-out-alt mr-1 text-red-500"></i>Clock Out Time</label>
        <input id="sem-clock-out" type="datetime-local" class="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
        <p class="text-xs text-gray-400 mt-1">Leave blank if session is still active.</p>
      </div>
      <div>
        <label class="text-xs font-semibold text-gray-600 block mb-1.5"><i class="fas fa-comment-alt mr-1 text-gray-400"></i>Reason <span class="text-red-500">*</span></label>
        <textarea id="sem-reason" rows="2" placeholder="Why are you editing this session? (required for audit trail)"
          class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"></textarea>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <button onclick="setVal('sem-reason','Worker forgot to clock out')" class="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-200">Forgot clock-out</button>
          <button onclick="setVal('sem-reason','GPS auto-clockout was incorrect')" class="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-200">GPS error</button>
          <button onclick="setVal('sem-reason','Worker dispute — time corrected')" class="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-200">Worker dispute</button>
          <button onclick="setVal('sem-reason','Payroll correction')" class="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-200">Payroll fix</button>
        </div>
      </div>
      <div id="sem-new-hours" class="hidden bg-green-50 border border-green-200 rounded-xl px-4 py-2.5 text-sm text-green-700 font-medium"></div>
      <div class="flex gap-3 pt-1">
        <button onclick="closeSessionEditModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl">Cancel</button>
        <button id="sem-confirm-btn" onclick="confirmSessionEdit()" class="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-bold py-3 rounded-xl shadow-lg shadow-amber-200">
          <i class="fas fa-save mr-1.5"></i>Save Changes
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── Day Detail Modal ────────────────────────────────────────────── -->
<div id="day-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" onclick="if(event.target===this)closeDayModal()">
  <div class="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
    <!-- Header -->
    <div class="bg-gradient-to-r from-emerald-500 to-teal-600 px-6 py-5 flex items-start justify-between">
      <div>
        <h2 id="dm-title" class="text-white text-lg font-bold"></h2>
        <p id="dm-sub" class="text-emerald-100 text-sm mt-0.5"></p>
      </div>
      <button onclick="closeDayModal()" class="text-white opacity-70 hover:opacity-100 mt-0.5">
        <i class="fas fa-times text-xl"></i>
      </button>
    </div>
    <!-- Stats strip -->
    <div id="dm-stats" class="grid grid-cols-3 gap-3 px-5 py-3 bg-gray-50 border-b text-center text-sm"></div>
    <!-- Sessions -->
    <div id="dm-sessions" class="p-5 space-y-3 max-h-[60vh] overflow-y-auto"></div>
  </div>
</div>

<!-- ── Admin Clock-Out Confirmation Modal ─────────────────────────────── -->
<div id="admin-clockout-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center p-4" onclick="if(event.target===this)closeAdminClockoutModal()">
  <div class="absolute inset-0 bg-black bg-opacity-60 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
    <!-- Header -->
    <div class="bg-gradient-to-r from-red-500 to-rose-600 px-6 py-5 text-center">
      <div class="w-14 h-14 bg-white bg-opacity-20 rounded-full flex items-center justify-center mx-auto mb-3">
        <i class="fas fa-stop-circle text-white text-2xl"></i>
      </div>
      <h2 class="text-white text-lg font-bold">Admin Clock-Out</h2>
      <p id="aco-worker-label" class="text-red-100 text-sm mt-1"></p>
    </div>
    <!-- Body -->
    <div class="p-6 space-y-4">
      <!-- Session info strip -->
      <div id="aco-info" class="bg-gray-50 rounded-2xl p-4 text-sm space-y-1.5"></div>
      <!-- Reason input (REQUIRED) -->
      <div>
        <label class="text-xs font-semibold text-gray-700 block mb-1.5">
          <i class="fas fa-comment-alt mr-1 text-red-400"></i>Reason for Clock-Out <span class="text-red-500 font-bold">*</span>
        </label>
        <textarea id="aco-note" rows="2" placeholder="Select a quick reason below or type your own..."
          class="w-full border-2 border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 focus:border-red-400 resize-none transition-colors"></textarea>
        <p id="aco-note-error" class="hidden text-xs text-red-500 mt-1"><i class="fas fa-exclamation-circle mr-1"></i>Please enter a reason before clocking out.</p>
        <!-- Quick reasons -->
        <p class="text-xs text-gray-400 mt-2 mb-1.5">Quick reasons:</p>
        <div class="flex flex-wrap gap-1.5">
          <button onclick="pickAcoReason('Worker left the job site')" class="text-xs bg-orange-50 text-orange-700 border border-orange-300 px-2.5 py-1.5 rounded-lg hover:bg-orange-100 font-medium transition-colors"><i class="fas fa-walking mr-1"></i>Left site</button>
          <button onclick="pickAcoReason('Worker forgot to clock out')" class="text-xs bg-yellow-50 text-yellow-700 border border-yellow-300 px-2.5 py-1.5 rounded-lg hover:bg-yellow-100 font-medium transition-colors"><i class="fas fa-clock mr-1"></i>Forgot to clock out</button>
          <button onclick="pickAcoReason('No GPS signal — admin action')" class="text-xs bg-blue-50 text-blue-700 border border-blue-300 px-2.5 py-1.5 rounded-lg hover:bg-blue-100 font-medium transition-colors"><i class="fas fa-map-marker-slash mr-1"></i>No GPS</button>
          <button onclick="pickAcoReason('End of work day')" class="text-xs bg-gray-100 text-gray-700 border border-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-200 font-medium transition-colors"><i class="fas fa-sun mr-1"></i>End of day</button>
          <button onclick="pickAcoReason('Worker left geofence area')" class="text-xs bg-purple-50 text-purple-700 border border-purple-300 px-2.5 py-1.5 rounded-lg hover:bg-purple-100 font-medium transition-colors"><i class="fas fa-map-marked-alt mr-1"></i>Left geofence</button>
          <button onclick="pickAcoReason('No-show / absent')" class="text-xs bg-rose-50 text-rose-700 border border-rose-300 px-2.5 py-1.5 rounded-lg hover:bg-rose-100 font-medium transition-colors"><i class="fas fa-user-slash mr-1"></i>No-show</button>
        </div>
      </div>
      <!-- Action buttons -->
      <div class="flex gap-3 pt-1">
        <button onclick="closeAdminClockoutModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition-colors">
          Cancel
        </button>
        <!-- Hold-to-confirm button: press & hold 2s to fire -->
        <div class="flex-1 relative overflow-hidden rounded-xl">
          <button id="aco-confirm-btn"
            onmousedown="startAcoHold(event)" ontouchstart="startAcoHold(event)"
            onmouseup="cancelAcoHold()" onmouseleave="cancelAcoHold()"
            ontouchend="cancelAcoHold()" ontouchcancel="cancelAcoHold()"
            class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-red-200 relative z-10 select-none">
            <i class="fas fa-stop-circle mr-1.5"></i><span id="aco-btn-label">Hold to Clock Out</span>
          </button>
          <!-- Fill bar -->
          <div id="aco-hold-bar" class="absolute bottom-0 left-0 h-full bg-red-800 bg-opacity-40 rounded-xl z-0 transition-none" style="width:0%"></div>
        </div>
      </div>
      <p class="text-center text-xs text-gray-400 pt-1 pb-1">Hold the button for 2 seconds to confirm</p>
    </div>
  </div>
</div>

<!-- ── Admin Bulk Drift Clock-Out Confirmation ─────────────────────────── -->
<div id="bulk-clockout-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center p-4" onclick="if(event.target===this)closeBulkClockoutModal()">
  <div class="absolute inset-0 bg-black bg-opacity-60 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
    <div class="bg-gradient-to-r from-orange-500 to-red-500 px-6 py-5 text-center">
      <div class="w-14 h-14 bg-white bg-opacity-20 rounded-full flex items-center justify-center mx-auto mb-3">
        <i class="fas fa-map-marker-slash text-white text-2xl"></i>
      </div>
      <h2 class="text-white text-lg font-bold">Clock Out All — Left Site</h2>
      <p id="bco-label" class="text-orange-100 text-sm mt-1"></p>
    </div>
    <div class="p-6 space-y-4">
      <div id="bco-list" class="bg-orange-50 rounded-2xl p-4 max-h-40 overflow-y-auto space-y-2 text-sm"></div>
      <p class="text-xs text-gray-500 text-center">These workers are outside the geofence. Their sessions will be stopped now and time recorded up to this moment.</p>
      <div class="flex gap-3">
        <button onclick="closeBulkClockoutModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl">Cancel</button>
        <button id="bco-confirm-btn" onclick="confirmBulkClockout()" class="flex-1 bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 rounded-xl shadow-lg shadow-orange-200">
          <i class="fas fa-stop-circle mr-1.5"></i>Stop All
        </button>
      </div>
    </div>
  </div>
</div>

<!-- ── Delete Worker Confirmation Modal ───────────────────────────────────── -->
<div id="delete-worker-modal" class="hidden fixed inset-0 z-[70] flex items-center justify-center p-4" onclick="if(event.target===this)closeDeleteWorkerModal()">
  <div class="absolute inset-0 bg-black bg-opacity-60 backdrop-blur-sm"></div>
  <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
    <div class="bg-gradient-to-r from-gray-700 to-gray-900 px-6 py-5 text-center">
      <div class="w-14 h-14 bg-white bg-opacity-10 rounded-full flex items-center justify-center mx-auto mb-3">
        <i class="fas fa-trash text-white text-xl"></i>
      </div>
      <h2 class="text-white text-lg font-bold">Remove Worker</h2>
      <p id="dw-worker-name" class="text-gray-300 text-sm mt-1"></p>
    </div>
    <div class="p-6 space-y-4">
      <div class="bg-red-50 border border-red-100 rounded-2xl p-4">
        <p class="text-sm text-red-700 font-medium mb-1"><i class="fas fa-exclamation-triangle mr-1.5"></i>This will permanently delete:</p>
        <ul class="text-xs text-red-600 space-y-1 mt-2 ml-4 list-disc">
          <li>All their clock-in / clock-out sessions</li>
          <li>GPS location history</li>
          <li>Their invite link</li>
        </ul>
        <p class="text-xs text-red-500 mt-3 font-medium">This action cannot be undone.</p>
      </div>
      <p class="text-xs text-gray-500 text-center">If you want to keep their history, use the <strong>Status tab</strong> to set them as <strong>Terminated</strong> instead.</p>
      <div class="flex gap-3 pt-1">
        <button onclick="closeDeleteWorkerModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition-colors">
          Cancel
        </button>
        <button id="dw-confirm-btn" onclick="confirmDeleteWorker()" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-red-200">
          <i class="fas fa-trash mr-1.5"></i>Delete Permanently
        </button>
      </div>
    </div>
  </div>
</div>

<script src="/static/admin.js?v=20260305g"></script>

</body>
</html>`
}

// ─── LEGAL PAGES (required by Intuit/QuickBooks App Partner Program) ─────────

app.get('/privacy', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Privacy Policy — ClockInProof</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-3xl mx-auto px-6 py-12">
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">C</div>
      <div>
        <p class="font-bold text-gray-900 text-lg">ClockInProof</p>
        <p class="text-xs text-gray-400">GPS-Verified Time Tracking</p>
      </div>
    </div>
    <h1 class="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
    <p class="text-sm text-gray-500 mb-8">Last updated: March 2, 2026</p>

    <div class="space-y-8 text-sm leading-relaxed">

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">1. Who We Are</h2>
        <p>ClockInProof ("we", "us", "our") is a GPS-verified employee time-tracking platform operated by Noweis Inc., based in Ontario, Canada. Our service is available at <strong>app.clockinproof.com</strong> (worker app) and <strong>admin.clockinproof.com</strong> (employer dashboard).</p>
        <p class="mt-2">Contact: <a href="mailto:support@clockinproof.com" class="text-indigo-600 underline">support@clockinproof.com</a></p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">2. Information We Collect</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><strong>Worker data:</strong> Name, phone number, PIN, job title, start date, emergency contact, driver's licence (optional)</li>
          <li><strong>Location data:</strong> GPS coordinates at clock-in, clock-out, and periodic pings during active shifts (used solely for fraud prevention and timesheet accuracy)</li>
          <li><strong>Work session data:</strong> Clock-in/out times, hours worked, job location, session type</li>
          <li><strong>Device data:</strong> A randomly-generated browser token stored in your phone's local storage. This is <strong>not</strong> biometric data — it cannot identify you as a person. It is used solely to verify that clock-in activity originates from the device you registered with. You give explicit informed consent before this token is recorded. You may request a device reset from your employer at any time.</li>
          <li><strong>Employer/admin data:</strong> Business name, email, phone, payroll settings, Twilio and QuickBooks integration credentials</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">3. How We Use Your Information</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li>To record and verify employee clock-in and clock-out times</li>
          <li>To detect GPS fraud (clocking in from a location different from the job site)</li>
          <li>To calculate payroll hours and generate payroll reports</li>
          <li>To send SMS notifications and invite links to workers via Twilio</li>
          <li>To push time-activity records to QuickBooks Online when the employer enables the integration</li>
          <li>To email payroll summaries to the employer's designated accountant</li>
          <li>To improve the reliability and security of the platform</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">4. QuickBooks Integration</h2>
        <p>When you connect ClockInProof to QuickBooks Online:</p>
        <ul class="list-disc pl-5 space-y-1 mt-2">
          <li>We request access only to the <strong>com.intuit.quickbooks.accounting</strong> scope</li>
          <li>We use this access solely to create <strong>TimeActivity</strong> records (employee hours) in your QB company</li>
          <li>We do not read, modify, or delete any financial records, invoices, bills, or bank data</li>
          <li>OAuth tokens are stored encrypted in our Cloudflare D1 database and never shared with third parties</li>
          <li>You can disconnect at any time via Settings → QuickBooks → Disconnect, which immediately revokes our access</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">5. Data Sharing</h2>
        <p>We do not sell, rent, or trade your personal information. We share data only with:</p>
        <ul class="list-disc pl-5 space-y-1 mt-2">
          <li><strong>Cloudflare</strong> — infrastructure provider (Workers, D1 database, Pages hosting)</li>
          <li><strong>Twilio</strong> — SMS delivery for worker invitations and notifications</li>
          <li><strong>Intuit/QuickBooks</strong> — only when you explicitly enable the QB integration</li>
          <li><strong>Resend</strong> — email delivery for payroll summaries</li>
          <li><strong>Your accountant</strong> — payroll reports sent at your explicit request</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">6. Data Retention</h2>
        <p>We retain your data for as long as you maintain an active account. Session and payroll data is retained for a minimum of 7 years to comply with Canadian employment record requirements. You may request deletion of your account and data by contacting us.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">7. Security</h2>
        <p>All data is transmitted over HTTPS/TLS. Database credentials and API tokens are stored as encrypted environment secrets. GPS data is stored only for active sessions and fraud-check purposes. We do not store raw payment card information.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">8. Your Rights (PIPEDA / Canadian Privacy Law)</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li>Right to access your personal data</li>
          <li>Right to correct inaccurate data</li>
          <li>Right to withdraw consent and request deletion</li>
          <li>Right to be informed of data breaches</li>
        </ul>
        <p class="mt-2">To exercise these rights, email <a href="mailto:support@clockinproof.com" class="text-indigo-600 underline">support@clockinproof.com</a>.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">8a. Device Verification &amp; Anti-Fraud Technology</h2>
        <p class="mb-2"><strong>What it is:</strong> ClockInProof uses a randomly-generated browser token ("device token") stored in your phone's browser local storage to verify that clock-in and clock-out activity originates from your registered device. This prevents "buddy punching" (a third party clocking in on your behalf).</p>
        <p class="mb-2"><strong>What it is NOT:</strong> This is not biometric data. It does not capture fingerprints, facial features, voice patterns, or any physical characteristic. It is a string of random letters and numbers — similar to how a website remembers you are logged in.</p>
        <p class="mb-2"><strong>Consent:</strong> Workers are shown a clear, plain-language consent screen the first time they register on a device. Clock-in is not possible without consent. This satisfies the requirements of:</p>
        <ul class="list-disc pl-5 space-y-1 mb-2">
          <li><strong>Canada — PIPEDA</strong> (Principle 3: Consent; Principle 4.8: Openness)</li>
          <li><strong>Ontario</strong> — Employment Standards Act, Electronic Monitoring Policy requirements</li>
          <li><strong>Alberta/BC — PIPA</strong> — Employer consent for employee personal information collection</li>
          <li><strong>Quebec — Law 25</strong> — Transparency and consent obligations</li>
          <li><strong>US — CCPA (California)</strong> — Notice at collection; no biometric data is collected</li>
          <li><strong>Illinois BIPA</strong> — Does not apply (no biometric identifiers collected)</li>
          <li><strong>US Federal — ECPA</strong> — Monitoring disclosed to employees in advance</li>
        </ul>
        <p class="mb-2"><strong>Data minimization:</strong> The token is stored only in the database record for the worker. It is never shared with third parties, never used for purposes other than clock-in verification, and never combined with browsing data.</p>
        <p class="mb-2"><strong>Right to reset:</strong> Workers may request a device reset at any time through the worker app ("I have a new phone"). The employer is notified and must manually approve the reset. Workers retain full control of this process.</p>
        <p><strong>Retention:</strong> The device token is deleted when the worker's account is deleted. Employers may reset it at any time from the admin dashboard.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">9. Changes to This Policy</h2>
        <p>We may update this policy periodically. We will notify users of material changes via the admin dashboard or email. Continued use of ClockInProof after changes constitutes acceptance.</p>
      </section>

    </div>

    <div class="mt-12 pt-6 border-t border-gray-200 text-xs text-gray-400 flex justify-between">
      <span>© 2026 ClockInProof / Noweis Inc. — Ontario, Canada</span>
      <a href="/terms" class="text-indigo-500 underline">Terms of Service</a>
    </div>
  </div>
</body>
</html>`)
})

app.get('/terms', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Terms of Service — ClockInProof</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-3xl mx-auto px-6 py-12">
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">C</div>
      <div>
        <p class="font-bold text-gray-900 text-lg">ClockInProof</p>
        <p class="text-xs text-gray-400">GPS-Verified Time Tracking</p>
      </div>
    </div>
    <h1 class="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
    <p class="text-sm text-gray-500 mb-8">Last updated: March 2, 2026</p>

    <div class="space-y-8 text-sm leading-relaxed">

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">1. Acceptance of Terms</h2>
        <p>By accessing or using ClockInProof ("Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service. These terms apply to all users including employers (admins) and employees (workers).</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">2. Description of Service</h2>
        <p>ClockInProof is a GPS-verified employee time-tracking platform. It enables employers to:</p>
        <ul class="list-disc pl-5 space-y-1 mt-2">
          <li>Track employee clock-in and clock-out times with GPS verification</li>
          <li>Generate payroll reports and export to accounting software</li>
          <li>Integrate with QuickBooks Online to push time records directly</li>
          <li>Manage workers, job sites, and pay periods</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">3. Accounts and Access</h2>
        <p>Employers are responsible for maintaining the security of their admin PIN and account credentials. Workers are responsible for accurate clock-in and clock-out reporting. Fraudulent GPS spoofing or false time entries may result in account suspension.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">4. QuickBooks Integration Terms</h2>
        <p>By connecting ClockInProof to QuickBooks Online, you authorize ClockInProof to:</p>
        <ul class="list-disc pl-5 space-y-1 mt-2">
          <li>Create TimeActivity records in your QuickBooks company on your behalf</li>
          <li>Read your QuickBooks employee list to enable worker mapping</li>
          <li>Refresh access tokens automatically to maintain the connection</li>
        </ul>
        <p class="mt-2">You may disconnect the integration at any time. ClockInProof is not affiliated with or endorsed by Intuit Inc. QuickBooks is a registered trademark of Intuit Inc.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">5. Employer Responsibilities</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li>Employers must obtain proper consent from employees before collecting GPS location data</li>
          <li>Employers are responsible for compliance with applicable employment standards legislation (ESA Ontario, Canada Labour Code, etc.)</li>
          <li>Payroll calculations provided by ClockInProof are for reference only — employers are responsible for final payroll accuracy</li>
          <li>Employers must not use the Service to discriminate, harass, or unfairly monitor employees</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">6. Acceptable Use</h2>
        <p>You agree not to:</p>
        <ul class="list-disc pl-5 space-y-1 mt-2">
          <li>Use the Service for any unlawful purpose</li>
          <li>Attempt to bypass GPS fraud detection mechanisms</li>
          <li>Share admin credentials with unauthorized parties</li>
          <li>Reverse engineer or attempt to extract source code from the platform</li>
          <li>Use the Service to collect data about individuals without their knowledge</li>
        </ul>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">7. Limitation of Liability</h2>
        <p>ClockInProof is provided "as is". We are not liable for any indirect, incidental, or consequential damages arising from use of the Service, including payroll errors, data loss, or QuickBooks sync failures. Our maximum liability is limited to the amount paid for the Service in the prior 12 months.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">8. Termination</h2>
        <p>We reserve the right to suspend or terminate accounts that violate these terms. Upon termination, your data will be retained for 90 days then deleted, unless legal obligations require longer retention.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">9. Governing Law</h2>
        <p>These terms are governed by the laws of the Province of Ontario and the federal laws of Canada applicable therein. Any disputes shall be resolved in the courts of Ontario.</p>
      </section>

      <section>
        <h2 class="text-lg font-bold text-gray-800 mb-2">10. Contact</h2>
        <p>For questions about these terms: <a href="mailto:support@clockinproof.com" class="text-indigo-600 underline">support@clockinproof.com</a></p>
        <p class="mt-1">Noweis Inc., Ontario, Canada</p>
      </section>

    </div>

    <div class="mt-12 pt-6 border-t border-gray-200 text-xs text-gray-400 flex justify-between">
      <span>© 2026 ClockInProof / Noweis Inc. — Ontario, Canada</span>
      <a href="/privacy" class="text-indigo-500 underline">Privacy Policy</a>
    </div>
  </div>
</body>
</html>`)
})

// ─── LEGAL ALIAS ROUTES (for Intuit App Store compliance) ────────────────────
// /legal/privacy → same as /privacy
// /legal/eula    → same as /terms
app.get('/legal/privacy', (c) => c.redirect('/privacy', 301))
app.get('/legal/eula',    (c) => c.redirect('/terms', 301))
app.get('/legal/terms',   (c) => c.redirect('/terms', 301))

// ─── SUPER ADMIN HTML ─────────────────────────────────────────────────────────
function getSuperAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClockInProof — Super Admin</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:system-ui,-apple-system,sans-serif;height:100vh;overflow:hidden}
a{color:inherit;text-decoration:none}
/* ── Layout ── */
#login-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 100%)}
#app{display:none;height:100vh;display:grid;grid-template-rows:56px 1fr;grid-template-columns:220px 1fr}
#topbar{grid-column:1/-1;background:#0f172a;border-bottom:1px solid #1e293b;display:flex;align-items:center;justify-content:space-between;padding:0 20px;z-index:50}
#sidebar{background:#0c1322;border-right:1px solid #1e293b;overflow-y:auto;display:flex;flex-direction:column;padding:12px 8px;transition:transform .25s ease}
#content{overflow-y:auto;background:#0f172a}
/* ── Mobile sidebar ── */
#sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:90;backdrop-filter:blur(2px)}
#hamburger{display:none;background:none;border:none;color:#e2e8f0;font-size:20px;cursor:pointer;padding:4px 8px;margin-right:4px}
@media(max-width:768px){
  #app{grid-template-columns:1fr}
  #sidebar{position:fixed;top:56px;left:0;bottom:0;width:240px;z-index:100;transform:translateX(-100%)}
  #sidebar.open{transform:translateX(0)}
  #hamburger{display:flex;align-items:center;justify-content:center}
}
/* ── Cards & common ── */
.card{background:#1e293b;border:1px solid #334155;border-radius:12px}
.stat-card{background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid #334155;border-radius:12px;padding:20px}
.section-header{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;padding:8px 10px 4px}
/* ── Sidebar nav ── */
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;font-weight:500;color:#94a3b8;cursor:pointer;transition:all .15s;border:none;background:transparent;width:100%;text-align:left}
.nav-item:hover{background:#1e293b;color:#e2e8f0}
.nav-item.active{background:#312e81;color:#a5b4fc}
.nav-item i{width:16px;text-align:center;font-size:14px}
.nav-badge{margin-left:auto;background:#ef4444;color:#fff;border-radius:20px;padding:1px 7px;font-size:10px;font-weight:700}
.nav-badge.green{background:#059669}
/* ── Badges / pills ── */
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase}
.badge-active{background:#065f46;color:#6ee7b7}
.badge-trial{background:#78350f;color:#fcd34d}
.badge-suspended{background:#7f1d1d;color:#fca5a5}
.badge-deleted{background:#1e293b;color:#64748b}
.badge-starter{background:#1e3a5f;color:#93c5fd}
.badge-growth{background:#3b1f6b;color:#c4b5fd}
.badge-pro{background:#14532d;color:#86efac}
/* ── Buttons ── */
.btn{border-radius:8px;padding:7px 16px;font-weight:600;font-size:13px;cursor:pointer;border:none;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:#4f46e5;color:#fff}.btn-primary:hover{background:#4338ca}
.btn-danger{background:#dc2626;color:#fff;padding:5px 12px;font-size:12px}.btn-danger:hover{background:#b91c1c}
.btn-success{background:#059669;color:#fff;padding:5px 12px;font-size:12px}.btn-success:hover{background:#047857}
.btn-ghost{background:#1e293b;color:#94a3b8;padding:5px 12px;font-size:12px;border:1px solid #334155}.btn-ghost:hover{background:#334155;color:#e2e8f0}
.btn-warning{background:#d97706;color:#fff;padding:5px 12px;font-size:12px}.btn-warning:hover{background:#b45309}
/* ── Inputs ── */
.input{background:#0f172a;border:1px solid #475569;color:#e2e8f0;border-radius:8px;padding:8px 12px;width:100%;outline:none;font-size:13px}
.input:focus{border-color:#4f46e5}
select.input option{background:#1e293b}
/* ── Table ── */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1px solid #334155;white-space:nowrap}
.tbl td{padding:10px 14px;border-bottom:1px solid #1e293b;vertical-align:middle}
.tbl tr:hover td{background:#1e293b55}
/* ── Tab pages ── */
.page{display:none;padding:24px}
.page.active{display:block}
/* ── Modal ── */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center;padding:16px}
.modal-bg.open{display:flex}
/* ── Toast ── */
#toast{position:fixed;bottom:24px;right:24px;background:#1e293b;border:1px solid #4f46e5;color:#e2e8f0;padding:12px 20px;border-radius:10px;z-index:9999;font-size:14px;box-shadow:0 4px 24px rgba(0,0,0,.5);display:none}
/* ── Misc ── */
.live-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.empty-state{text-align:center;padding:48px 16px;color:#475569}
.empty-state i{font-size:36px;margin-bottom:12px;display:block}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#334155;border-radius:4px}
</style>
</head>
<body>

<!-- ══════════════════════════ LOGIN SCREEN ══════════════════════════ -->
<div id="login-screen">
  <div class="card" style="padding:40px;width:100%;max-width:380px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="width:64px;height:64px;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
        <i class="fas fa-shield-halved" style="font-size:28px;color:#fff"></i>
      </div>
      <h1 style="font-size:22px;font-weight:800;color:#fff">Super Admin</h1>
      <p style="color:#64748b;font-size:13px;margin-top:4px">ClockInProof Platform Control</p>
    </div>
    <div id="login-error" style="display:none;background:#7f1d1d33;border:1px solid #dc2626;color:#fca5a5;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px"></div>
    <input type="password" id="super-pin" class="input" style="text-align:center;font-size:22px;letter-spacing:8px;margin-bottom:14px" placeholder="••••••••" maxlength="30" autocomplete="current-password">
    <button id="login-btn" class="btn btn-primary" style="width:100%;justify-content:center;padding:10px" onclick="doSuperLogin()">
      <i class="fas fa-unlock-keyhole"></i> Access Portal
    </button>
    <p style="text-align:center;font-size:11px;color:#334155;margin-top:16px">Protected — authorized personnel only</p>
  </div>
</div>

<!-- ══════════════════════════ APP SHELL ══════════════════════════ -->
<div id="app" style="display:none">

  <!-- TOP BAR -->
  <div id="topbar">
    <div style="display:flex;align-items:center;gap:8px">
      <button id="hamburger" onclick="toggleSidebar()" aria-label="Toggle menu"><i class="fas fa-bars"></i></button>
      <div style="width:32px;height:32px;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:8px;display:flex;align-items:center;justify-content:center">
        <i class="fas fa-shield-halved" style="color:#fff;font-size:14px"></i>
      </div>
      <span style="font-weight:800;font-size:16px;color:#fff">ClockInProof</span>
      <span class="pill badge-pro" style="font-size:10px">SUPER ADMIN</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:12px;color:#475569">Refreshed: <span id="last-refresh">—</span></span>
      <button class="btn btn-ghost" onclick="refreshCurrent()"><i class="fas fa-rotate-right"></i></button>
      <button class="btn btn-danger" onclick="doLogout()" style="padding:6px 14px"><i class="fas fa-sign-out-alt"></i> Logout</button>
    </div>
  </div>

  <!-- SIDEBAR -->
  <div id="sidebar">
    <div class="section-header">Platform</div>
    <button class="nav-item active" id="nav-overview" onclick="showPage('overview')">
      <i class="fas fa-chart-pie"></i> Overview
    </button>
    <button class="nav-item" id="nav-live" onclick="showPage('live')">
      <i class="fas fa-circle" style="color:#22c55e;font-size:8px;margin-right:2px"></i><span style="margin-left:-4px">Live Activity</span>
      <span class="nav-badge green" id="live-count-badge">0</span>
    </button>

    <div class="section-header" style="margin-top:8px">Tenants</div>
    <button class="nav-item" id="nav-tenants" onclick="showPage('tenants')">
      <i class="fas fa-building"></i> All Tenants
    </button>
    <button class="nav-item" id="nav-add-tenant" onclick="showPage('add-tenant')">
      <i class="fas fa-plus-circle"></i> Add Tenant
    </button>

    <div class="section-header" style="margin-top:8px">Data</div>
    <button class="nav-item" id="nav-sessions" onclick="showPage('sessions')">
      <i class="fas fa-clock"></i> All Sessions
    </button>

    <div class="section-header" style="margin-top:8px">Finance</div>
    <button class="nav-item" id="nav-revenue" onclick="showPage('revenue')">
      <i class="fas fa-dollar-sign"></i> Revenue / MRR
    </button>
    <button class="nav-item" id="nav-tax" onclick="showPage('tax')">
      <i class="fas fa-file-invoice-dollar"></i> Tax Compliance
      <span class="nav-badge" id="tax-alert-badge" style="display:none">!</span>
    </button>

    <div class="section-header" style="margin-top:8px">Growth</div>
    <button class="nav-item" id="nav-trial-links" onclick="showPage('trial-links')">
      <i class="fas fa-link"></i> Trial Links
    </button>
    <button class="nav-item" id="nav-leads" onclick="showPage('leads')">
      <i class="fas fa-user-plus"></i> Signup Leads
      <span class="nav-badge green" id="leads-badge" style="display:none">0</span>
    </button>

    <div class="section-header" style="margin-top:8px">Support</div>
    <button class="nav-item" id="nav-support" onclick="showPage('support')">
      <i class="fas fa-life-ring"></i> Support Tickets
      <span class="nav-badge" id="support-badge" style="display:none">0</span>
    </button>

    <div class="section-header" style="margin-top:8px">Config</div>
    <button class="nav-item" id="nav-plans" onclick="showPage('plans')">
      <i class="fas fa-layer-group"></i> Plans & Pricing
    </button>
    <button class="nav-item" id="nav-email" onclick="showPage('email')">
      <i class="fas fa-envelope"></i> Email & Alerts
    </button>
    <button class="nav-item" id="nav-platform" onclick="showPage('platform')">
      <i class="fas fa-sliders"></i> Platform Settings
    </button>

    <div style="flex:1"></div>
    <div style="padding:10px 12px;font-size:11px;color:#334155;border-top:1px solid #1e293b;margin-top:8px">
      <i class="fas fa-lock" style="margin-right:4px"></i>Secure session
    </div>
  </div>
  <!-- Overlay (mobile) -->
  <div id="sidebar-overlay" onclick="closeSidebar()"></div>

  <!-- CONTENT AREA -->
  <div id="content">

    <!-- ── OVERVIEW ──────────────────────────────────────── -->
    <div class="page active" id="page-overview">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff">Platform Overview</h1>
          <p style="color:#64748b;font-size:13px">Real-time platform health</p>
        </div>
      </div>
      <!-- Stats row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px">
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px"><i class="fas fa-building mr-1"></i>Tenants</div>
          <div style="font-size:32px;font-weight:800;color:#fff" id="ov-tenants">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">active accounts</div>
        </div>
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px"><i class="fas fa-users mr-1"></i>Workers</div>
          <div style="font-size:32px;font-weight:800;color:#34d399" id="ov-workers">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">total active</div>
        </div>
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px"><i class="fas fa-circle live-dot mr-1"></i>Live Now</div>
          <div style="font-size:32px;font-weight:800;color:#facc15" id="ov-live">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">clocked in</div>
        </div>
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px"><i class="fas fa-calendar-check mr-1"></i>Sessions</div>
          <div style="font-size:32px;font-weight:800;color:#818cf8" id="ov-sessions">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">all time</div>
        </div>
      </div>
      <!-- Plan breakdown + recent tenants side by side -->
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:14px">
        <div class="card" style="padding:18px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-layer-group" style="color:#818cf8;margin-right:6px"></i>PLAN BREAKDOWN</h3>
          <div id="ov-plans" style="display:flex;flex-direction:column;gap:8px"><span style="color:#475569;font-size:13px">Loading...</span></div>
        </div>
        <div class="card" style="padding:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <h3 style="font-size:13px;font-weight:700;color:#94a3b8"><i class="fas fa-clock" style="color:#818cf8;margin-right:6px"></i>RECENT TENANTS</h3>
            <button class="btn btn-ghost" onclick="showPage('tenants')" style="font-size:11px;padding:3px 10px">View all</button>
          </div>
          <div id="ov-recent" style="display:flex;flex-direction:column;gap:6px"><span style="color:#475569;font-size:13px">Loading...</span></div>
        </div>
      </div>
    </div>

    <!-- ── LIVE ACTIVITY ──────────────────────────────────── -->
    <div class="page" id="page-live">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff"><span class="live-dot" style="margin-right:8px"></span>Live Activity</h1>
          <p style="color:#64748b;font-size:13px">Workers currently clocked in across all tenants</p>
        </div>
        <button class="btn btn-ghost" onclick="loadLive()"><i class="fas fa-rotate-right"></i> Refresh</button>
      </div>
      <div class="card" style="overflow:hidden">
        <table class="tbl">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Tenant</th>
              <th>Clocked In</th>
              <th>Duration</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody id="live-tbody">
            <tr><td colspan="5" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── ALL TENANTS ──────────────────────────────────── -->
    <div class="page" id="page-tenants">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff">All Tenants</h1>
          <p style="color:#64748b;font-size:13px" id="tenant-count-label">Loading...</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="tenant-search" class="input" style="width:180px" placeholder="Search..." oninput="filterTenants()">
          <select id="tenant-filter-status" class="input" style="width:130px" onchange="filterTenants()">
            <option value="">All Status</option>
            <option value="active">Active</option>
            <option value="trial">Trial</option>
            <option value="suspended">Suspended</option>
          </select>
          <select id="tenant-filter-plan" class="input" style="width:120px" onchange="filterTenants()">
            <option value="">All Plans</option>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="pro">Pro</option>
          </select>
          <button class="btn btn-primary" onclick="showPage('add-tenant')"><i class="fas fa-plus"></i> Add</button>
        </div>
      </div>

      <!-- Tabs: Active | Archived -->
      <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #1e293b;padding-bottom:0">
        <button id="tab-active-tenants" onclick="switchTenantTab('active')" style="padding:8px 18px;background:none;border:none;border-bottom:2px solid #818cf8;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
          <i class="fas fa-building" style="margin-right:6px;color:#818cf8"></i>Active Companies
        </button>
        <button id="tab-archived-tenants" onclick="switchTenantTab('archived')" style="padding:8px 18px;background:none;border:none;border-bottom:2px solid transparent;color:#64748b;font-size:13px;font-weight:600;cursor:pointer">
          <i class="fas fa-archive" style="margin-right:6px;color:#f59e0b"></i>Archive
          <span id="archived-count-badge" style="display:none;background:#f59e0b;color:#000;font-size:10px;font-weight:800;padding:1px 6px;border-radius:20px;margin-left:4px">0</span>
        </button>
      </div>

      <!-- Active tenants table -->
      <div id="active-tenants-panel">
        <div class="card" style="overflow:hidden">
          <table class="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Subdomain</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Workers</th>
                <th>Sessions</th>
                <th>Last Active</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody id="tenants-tbody">
              <tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Archived tenants panel -->
      <div id="archived-tenants-panel" style="display:none">
        <div class="card" style="padding:20px;margin-bottom:16px;background:#1e293b;border:1px solid #f59e0b22">
          <div style="display:flex;align-items:center;gap:12px">
            <i class="fas fa-shield-alt" style="color:#f59e0b;font-size:20px"></i>
            <div>
              <div style="font-weight:700;color:#fbbf24;font-size:14px">90-Day Data Guardrail</div>
              <div style="color:#94a3b8;font-size:12px;margin-top:2px">Archived companies and all their data (workers, sessions, GPS pings) are permanently deleted after 90 days. You can restore them at any time before the purge date.</div>
            </div>
          </div>
        </div>
        <div class="card" style="overflow:hidden">
          <table class="tbl">
            <thead>
              <tr>
                <th>Company</th>
                <th>Subdomain</th>
                <th>Admin Email</th>
                <th>Workers</th>
                <th>Sessions</th>
                <th>Archived On</th>
                <th style="color:#ef4444">Purge In</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody id="archived-tbody">
              <tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ── ADD TENANT ──────────────────────────────────── -->
    <div class="page" id="page-add-tenant">
      <div style="max-width:680px">
        <h1 style="font-size:20px;font-weight:800;color:#fff;margin-bottom:6px">Create New Tenant</h1>
        <p style="color:#64748b;font-size:13px;margin-bottom:20px">Set up a new company account on ClockInProof</p>
        <div class="card" style="padding:24px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Company Name *</label>
              <input type="text" id="new-company" class="input" placeholder="Acme Cleaning Co.">
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Subdomain * <span style="color:#818cf8;text-transform:lowercase;font-weight:400">.clockinproof.com</span></label>
              <div style="display:flex;align-items:center;gap:8px">
                <input type="text" id="new-slug" class="input" placeholder="acme-cleaning" oninput="onSlugInput()">
                <span id="slug-check" style="font-size:18px;width:24px;text-align:center"></span>
              </div>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Admin Email <span style="color:#818cf8;text-transform:lowercase;font-weight:400">(auto-generated)</span></label>
              <div style="display:flex;align-items:center;background:#0f172a;border:1px solid #475569;border-radius:8px;overflow:hidden">
                <span style="padding:8px 10px;color:#64748b;font-size:13px;white-space:nowrap">admin.</span>
                <input type="text" id="new-email-slug" style="flex:1;background:transparent;border:none;color:#e2e8f0;font-size:13px;padding:8px 0;outline:none" placeholder="company-name" oninput="onEmailSlugInput()">
                <span style="padding:8px 10px;color:#64748b;font-size:13px;white-space:nowrap">@clockinproof.com</span>
              </div>
              <p id="email-preview" style="font-size:11px;color:#818cf8;margin-top:4px;display:none"></p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Admin PIN <span style="color:#475569;text-transform:lowercase;font-weight:400">(default: 1234)</span></label>
              <input type="text" id="new-pin" class="input" placeholder="1234" maxlength="8">
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Plan</label>
              <select id="new-plan" class="input">
                <option value="">Loading plans…</option>
              </select>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Company Address</label>
              <input type="text" id="new-address" class="input" placeholder="123 Main St, City, Province">
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:#94a3b8;cursor:pointer;margin-bottom:16px">
            <input type="checkbox" id="new-send-welcome" checked style="width:15px;height:15px"> Send welcome email to admin
          </label>
          <div id="create-result" style="display:none;margin-bottom:14px"></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-primary" onclick="createTenant()" style="flex:1;justify-content:center;padding:10px">
              <i class="fas fa-plus-circle"></i> Create Tenant
            </button>
            <button class="btn btn-ghost" onclick="showPage('tenants')">Cancel</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── ALL SESSIONS ──────────────────────────────────── -->
    <div class="page" id="page-sessions">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff">All Sessions</h1>
          <p style="color:#64748b;font-size:13px">Clock-in/out records across all tenants</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="sess-tenant-filter" class="input" style="width:180px" onchange="loadSessions()">
            <option value="">All Tenants</option>
          </select>
          <button class="btn btn-ghost" onclick="loadSessions()"><i class="fas fa-rotate-right"></i></button>
        </div>
      </div>
      <div class="card" style="overflow:hidden;margin-bottom:12px">
        <table class="tbl">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Tenant</th>
              <th>Clock In</th>
              <th>Clock Out</th>
              <th>Hours</th>
              <th>Job Location</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="sessions-tbody">
            <tr><td colspan="7" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:12px">
        <span id="sess-info">—</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost" id="sess-prev" onclick="changeSessPage(-1)"><i class="fas fa-chevron-left"></i> Prev</button>
          <button class="btn btn-ghost" id="sess-next" onclick="changeSessPage(1)">Next <i class="fas fa-chevron-right"></i></button>
        </div>
      </div>
    </div>

    <!-- ── REVENUE / MRR ──────────────────────────────────── -->
    <div class="page" id="page-revenue">
      <div style="margin-bottom:20px">
        <h1 style="font-size:20px;font-weight:800;color:#fff">Revenue & MRR</h1>
        <p style="color:#64748b;font-size:13px">Monthly recurring revenue by tenant</p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px">
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Total MRR</div>
          <div style="font-size:32px;font-weight:800;color:#34d399">$<span id="rev-mrr">—</span></div>
          <div style="font-size:11px;color:#475569;margin-top:2px">per month</div>
        </div>
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Paying Tenants</div>
          <div style="font-size:32px;font-weight:800;color:#fff" id="rev-tenants">—</div>
        </div>
        <div class="stat-card">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">ARR Estimate</div>
          <div style="font-size:32px;font-weight:800;color:#818cf8">$<span id="rev-arr">—</span></div>
          <div style="font-size:11px;color:#475569;margin-top:2px">annualized</div>
        </div>
      </div>
      <div class="card" style="overflow:hidden">
        <table class="tbl">
          <thead>
            <tr>
              <th>Company</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Workers</th>
              <th>Sessions</th>
              <th>Hours Tracked</th>
              <th>MRR</th>
            </tr>
          </thead>
          <tbody id="revenue-tbody">
            <tr><td colspan="7" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── PLANS & PRICING ──────────────────────────────────── -->
    <div class="page" id="page-plans">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff">Plans & Pricing</h1>
          <p style="color:#64748b;font-size:13px">Edit plan name, price, features, worker limit, and Stripe Price ID — changes go live instantly on the public pricing page and signup flow.</p>
        </div>
        <a href="https://clockinproof.com/landing#pricing" target="_blank" class="btn btn-ghost" style="font-size:12px"><i class="fas fa-external-link-alt"></i> Preview Public Page</a>
      </div>

      <!-- Plan cards loaded dynamically -->
      <div id="plans-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;max-width:1000px">
        <div style="text-align:center;padding:40px;color:#475569;grid-column:1/-1"><i class="fas fa-spinner fa-spin"></i> Loading plans...</div>
      </div>

      <!-- Info banner -->
      <div class="card" style="padding:14px 16px;max-width:1000px;margin-top:20px;background:#0d1117;border-color:#1e3a5f">
        <p style="color:#64748b;font-size:12px;margin:0">
          <i class="fas fa-info-circle" style="color:#818cf8;margin-right:6px"></i>
          <strong style="color:#94a3b8">How this works:</strong>
          Editing a plan updates the public landing page, the signup page, and max_workers for all existing tenants on that plan — instantly.
          The <strong style="color:#94a3b8">Stripe Price ID</strong> field is for reference only — it must match the price you created in your Stripe dashboard.
          To change what Stripe bills a customer, update their subscription in the Stripe dashboard and the webhook will sync the plan back here automatically.
        </p>
      </div>
    </div>

    <!-- PLAN EDIT MODAL -->
    <div id="plan-edit-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:300;display:none;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)closePlanModal()">
      <div class="card" style="width:100%;max-width:540px;padding:28px;max-height:90vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <h3 style="font-size:16px;font-weight:700;color:#fff">Edit Plan</h3>
          <button onclick="closePlanModal()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px">✕</button>
        </div>

        <input type="hidden" id="plan-edit-id">

        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <label style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">Plan Name</label>
            <input id="plan-edit-name" class="input" placeholder="e.g. Starter">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">Price (CAD cents) <span style="color:#475569;font-size:10px">e.g. 4900 = $49</span></label>
              <input id="plan-edit-price" class="input" type="number" min="0" placeholder="4900">
            </div>
            <div>
              <label style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">Max Workers <span style="color:#475569;font-size:10px">999 = unlimited</span></label>
              <input id="plan-edit-workers" class="input" type="number" min="1" placeholder="10">
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">Stripe Price ID <span style="color:#475569;font-size:10px">from Stripe dashboard → Products</span></label>
            <input id="plan-edit-stripe-id" class="input" placeholder="price_1T6kPUGsh3cS5lan..." style="font-family:monospace;font-size:12px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px">Features <span style="color:#475569;font-size:10px">comma-separated, shown on pricing page</span></label>
            <textarea id="plan-edit-features" class="input" rows="4" placeholder="GPS clock-in proof,Geofence detection,Auto clock-out,Weekly reports" style="resize:vertical;font-size:12px"></textarea>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <label style="font-size:13px;color:#94a3b8;display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="plan-edit-active" style="width:16px;height:16px;accent-color:#4f46e5">
              Plan is active (visible on public page &amp; signup)
            </label>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:20px">
          <button onclick="savePlanEdit()" class="btn btn-primary" style="flex:1"><i class="fas fa-save"></i> Save Changes</button>
          <button onclick="closePlanModal()" class="btn btn-ghost">Cancel</button>
        </div>
        <div id="plan-edit-msg" style="margin-top:10px;font-size:12px;display:none"></div>
      </div>
    </div>

    <!-- ── EMAIL & ALERTS ──────────────────────────────────── -->
    <div class="page" id="page-email">
      <div style="margin-bottom:20px">
        <h1 style="font-size:20px;font-weight:800;color:#fff">Email & Alerts</h1>
        <p style="color:#64748b;font-size:13px">Platform-wide email configuration</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:900px">
        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-envelope" style="color:#818cf8;margin-right:6px"></i>EMAIL CONFIGURATION</h3>
          <div style="display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#0f172a;border-radius:8px">
              <span style="font-size:13px;color:#94a3b8">RESEND_API_KEY</span>
              <span class="pill badge-active">✓ Configured</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#0f172a;border-radius:8px">
              <span style="font-size:13px;color:#94a3b8">From Domain</span>
              <span style="font-size:13px;color:#e2e8f0">clockinproof.com ✓</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#0f172a;border-radius:8px">
              <span style="font-size:13px;color:#94a3b8">DKIM Status</span>
              <span class="pill badge-active">Verified</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:#0f172a;border-radius:8px">
              <span style="font-size:13px;color:#94a3b8">SPF Status</span>
              <span class="pill badge-active">Verified</span>
            </div>
          </div>
        </div>
        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-paper-plane" style="color:#818cf8;margin-right:6px"></i>SENDING ADDRESSES</h3>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
            <div style="padding:10px;background:#0f172a;border-radius:8px">
              <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:3px">GPS Fraud Alerts</div>
              <div style="color:#e2e8f0">alerts@clockinproof.com</div>
            </div>
            <div style="padding:10px;background:#0f172a;border-radius:8px">
              <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:3px">Weekly Reports</div>
              <div style="color:#e2e8f0">reports@clockinproof.com</div>
            </div>
            <div style="padding:10px;background:#0f172a;border-radius:8px">
              <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:3px">Payslips</div>
              <div style="color:#e2e8f0">payroll@clockinproof.com</div>
            </div>
            <div style="padding:10px;background:#0f172a;border-radius:8px">
              <div style="color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:3px">Welcome Emails</div>
              <div style="color:#e2e8f0">admin.{slug}@clockinproof.com</div>
            </div>
          </div>
        </div>
        <div class="card" style="padding:20px;grid-column:1/-1">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-vial" style="color:#818cf8;margin-right:6px"></i>TEST EMAIL</h3>
          <div style="display:flex;gap:10px;align-items:flex-end">
            <div style="flex:1">
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Send test to</label>
              <input type="email" id="test-email-to" class="input" placeholder="admin@clockinproof.com" value="admin@clockinproof.com">
            </div>
            <button class="btn btn-primary" onclick="sendTestEmail()" style="white-space:nowrap">
              <i class="fas fa-paper-plane"></i> Send Test
            </button>
          </div>
          <div id="test-email-result" style="margin-top:10px;font-size:13px;display:none"></div>
        </div>
      </div>
    </div>

    <!-- ── PLATFORM SETTINGS ──────────────────────────────────── -->
    <div class="page" id="page-platform">
      <div style="margin-bottom:20px">
        <h1 style="font-size:20px;font-weight:800;color:#fff">Platform Settings</h1>
        <p style="color:#64748b;font-size:13px">Global configuration for ClockInProof</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:900px">
        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-shield-halved" style="color:#818cf8;margin-right:6px"></i>SECURITY</h3>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Super Admin PIN</label>
              <div style="display:flex;gap:8px">
                <input type="password" id="new-super-pin" class="input" placeholder="New PIN (min 6 chars)" maxlength="30">
                <button class="btn btn-warning" onclick="changeSuperPin()">Update</button>
              </div>
              <p style="font-size:11px;color:#475569;margin-top:4px">Stored as SUPER_ADMIN_PIN Cloudflare secret</p>
            </div>
          </div>
        </div>

        <!-- TWILIO SMS CREDENTIALS -->
        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:4px">
            <i class="fas fa-sms" style="color:#818cf8;margin-right:6px"></i>TWILIO SMS
          </h3>
          <p style="font-size:11px;color:#475569;margin-bottom:14px">Platform SMS credentials — shared across all tenants. Stored as Cloudflare secrets in production.</p>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Account SID</label>
              <input type="text" id="sp-twilio-sid" class="input" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
              <p style="font-size:10px;color:#475569;margin-top:3px">Set as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;color:#a5b4fc">TWILIO_ACCOUNT_SID</code> Cloudflare secret</p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Auth Token</label>
              <input type="password" id="sp-twilio-token" class="input" placeholder="Your Twilio Auth Token">
              <p style="font-size:10px;color:#475569;margin-top:3px">Set as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;color:#a5b4fc">TWILIO_AUTH_TOKEN</code> Cloudflare secret</p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">From Number</label>
              <input type="tel" id="sp-twilio-from" class="input" placeholder="+16135550100">
              <p style="font-size:10px;color:#475569;margin-top:3px">Set as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;color:#a5b4fc">TWILIO_FROM_NUMBER</code> Cloudflare secret</p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Messaging Service SID <span style="font-weight:400;text-transform:none">(optional — overrides From Number)</span></label>
              <input type="text" id="sp-twilio-msgsvc" class="input" placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx">
              <p style="font-size:10px;color:#475569;margin-top:3px">Set as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;color:#a5b4fc">TWILIO_MESSAGING_SERVICE</code> Cloudflare secret</p>
            </div>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button class="btn btn-primary" onclick="savePlatformTwilio()"><i class="fas fa-save"></i> Save to DB</button>
              <button class="btn btn-ghost" onclick="testPlatformSms()"><i class="fas fa-paper-plane"></i> Send Test SMS</button>
            </div>
            <div style="background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:10px;font-size:11px;color:#64748b">
              <strong style="color:#94a3b8">Production setup:</strong> Add these as Cloudflare Pages secrets via the dashboard or wrangler CLI.
              They take priority over anything saved in the database.
              <br><br>
              <code style="color:#a5b4fc">wrangler pages secret put TWILIO_ACCOUNT_SID</code><br>
              <code style="color:#a5b4fc">wrangler pages secret put TWILIO_AUTH_TOKEN</code><br>
              <code style="color:#a5b4fc">wrangler pages secret put TWILIO_FROM_NUMBER</code>
            </div>
            <p id="sp-twilio-status" style="font-size:12px;color:#34d399;display:none"></p>
          </div>
        </div>

        <!-- RESEND EMAIL CREDENTIALS -->
        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:4px">
            <i class="fas fa-envelope" style="color:#818cf8;margin-right:6px"></i>RESEND EMAIL
          </h3>
          <p style="font-size:11px;color:#475569;margin-bottom:14px">Platform email credentials — powers all alerts, weekly reports, and invite emails.</p>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Resend API Key</label>
              <input type="password" id="sp-resend-key" class="input" placeholder="re_xxxxxxxxxxxxxxxxxxxx">
              <p style="font-size:10px;color:#475569;margin-top:3px">Set as <code style="background:#0f172a;padding:1px 4px;border-radius:3px;color:#a5b4fc">RESEND_API_KEY</code> Cloudflare secret</p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">From Address</label>
              <input type="email" id="sp-resend-from" class="input" placeholder="alerts@clockinproof.com">
              <p style="font-size:10px;color:#475569;margin-top:3px">The "From" address on all platform emails. Must be a verified Resend domain.</p>
            </div>
            <div style="display:flex;gap:8px;margin-top:4px">
              <button class="btn btn-primary" onclick="savePlatformResend()"><i class="fas fa-save"></i> Save</button>
              <button class="btn btn-ghost" onclick="testPlatformEmail()"><i class="fas fa-paper-plane"></i> Send Test Email</button>
            </div>
            <div style="background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:10px;font-size:11px;color:#64748b">
              <strong style="color:#94a3b8">Production setup:</strong><br>
              <code style="color:#a5b4fc">wrangler pages secret put RESEND_API_KEY</code>
            </div>
            <p id="sp-resend-status" style="font-size:12px;color:#34d399;display:none"></p>
          </div>
        </div>
        <!-- APP URLs / DOMAIN CONFIGURATION -->
        <div class="card" style="padding:20px;grid-column:1/-1">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px">
            <i class="fas fa-link" style="color:#818cf8;margin-right:6px"></i>APP URLs &amp; DOMAIN CONFIGURATION
            <span style="font-size:10px;font-weight:500;color:#475569;margin-left:8px;text-transform:none">Platform infrastructure — not visible to tenant admins</span>
          </h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">
                Worker App URL <span style="text-transform:none;font-weight:400">(workers clock in here)</span>
              </label>
              <input type="url" id="sp-app-host" class="input" placeholder="https://app.clockinproof.com">
              <p style="font-size:11px;color:#475569;margin-top:4px">
                <i class="fas fa-info-circle" style="margin-right:4px"></i>
                In Cloudflare DNS, point <code style="background:#0f172a;padding:1px 5px;border-radius:4px">app.clockinproof.com</code> → this Pages project.
              </p>
            </div>
            <div>
              <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">
                Admin Portal URL <span style="text-transform:none;font-weight:400">(this dashboard)</span>
              </label>
              <input type="url" id="sp-admin-host" class="input" placeholder="https://admin.clockinproof.com">
              <p style="font-size:11px;color:#475569;margin-top:4px">
                <i class="fas fa-info-circle" style="margin-right:4px"></i>
                In Cloudflare DNS, point <code style="background:#0f172a;padding:1px 5px;border-radius:4px">admin.clockinproof.com</code> → this Pages project. Alert SMS links use this URL.
              </p>
            </div>
          </div>
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-top:14px;font-size:12px;color:#64748b">
            <p style="font-weight:700;color:#94a3b8;margin-bottom:8px"><i class="fas fa-lightbulb" style="color:#f59e0b;margin-right:6px"></i>Cloudflare DNS Quick Setup</p>
            <p>1. Cloudflare Dashboard → <strong style="color:#e2e8f0">clockinproof.com → DNS</strong></p>
            <p style="margin-top:4px">2. Add CNAME: <code style="background:#1e293b;padding:1px 5px;border-radius:4px;color:#a5b4fc">app</code> → your Pages URL</p>
            <p style="margin-top:4px">3. Add CNAME: <code style="background:#1e293b;padding:1px 5px;border-radius:4px;color:#a5b4fc">admin</code> → your Pages URL</p>
            <p style="margin-top:4px">4. Add CNAME: <code style="background:#1e293b;padding:1px 5px;border-radius:4px;color:#a5b4fc">www</code> → your Pages URL (landing page)</p>
            <p style="margin-top:4px">5. Pages → Custom Domains → add all three subdomains</p>
          </div>
          <div style="margin-top:14px;display:flex;gap:10px">
            <button class="btn btn-primary" onclick="savePlatformUrls()"><i class="fas fa-save"></i> Save URLs</button>
            <button class="btn btn-ghost" onclick="loadPlatformUrls()"><i class="fas fa-rotate-right"></i> Reload</button>
          </div>
          <p id="sp-url-status" style="font-size:12px;color:#34d399;margin-top:8px;display:none"></p>
        </div>

        <div class="card" style="padding:20px">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-globe" style="color:#818cf8;margin-right:6px"></i>PLATFORM INFO</h3>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
            <div style="display:flex;justify-content:space-between;padding:8px;background:#0f172a;border-radius:6px">
              <span style="color:#64748b">Platform</span><span style="color:#e2e8f0">ClockInProof</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px;background:#0f172a;border-radius:6px">
              <span style="color:#64748b">Runtime</span><span style="color:#e2e8f0">Cloudflare Workers</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px;background:#0f172a;border-radius:6px">
              <span style="color:#64748b">Database</span><span style="color:#e2e8f0">Cloudflare D1</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px;background:#0f172a;border-radius:6px">
              <span style="color:#64748b">Email</span><span style="color:#e2e8f0">Resend API</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px;background:#0f172a;border-radius:6px">
              <span style="color:#64748b">Domain</span><span style="color:#e2e8f0">clockinproof.com</span>
            </div>
          </div>
        </div>
        <div class="card" style="padding:20px;grid-column:1/-1">
          <h3 style="font-size:13px;font-weight:700;color:#94a3b8;margin-bottom:14px"><i class="fas fa-link" style="color:#818cf8;margin-right:6px"></i>QUICK LINKS</h3>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            <a href="https://dash.cloudflare.com" target="_blank" class="btn btn-ghost"><i class="fas fa-cloud"></i> Cloudflare Dashboard</a>
            <a href="https://resend.com/emails" target="_blank" class="btn btn-ghost"><i class="fas fa-envelope"></i> Resend Dashboard</a>
            <a href="https://admin.clockinproof.com" target="_blank" class="btn btn-ghost"><i class="fas fa-user-shield"></i> Tenant Admin Demo</a>
            <a href="https://app.clockinproof.com" target="_blank" class="btn btn-ghost"><i class="fas fa-mobile-alt"></i> Worker App Demo</a>
          </div>
        </div>
      </div>
    </div>

    <!-- ── SUPPORT TICKETS ──────────────────────────────────── -->
    <div class="page" id="page-support">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff">Support Tickets</h1>
          <p style="color:#64748b;font-size:13px">Manage all tenant support requests</p>
        </div>
        <button class="btn btn-ghost" onclick="loadTickets()"><i class="fas fa-rotate-right"></i> Refresh</button>
      </div>
      <!-- Stats bar -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        <div class="stat-card" style="padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Open</div>
          <div style="font-size:28px;font-weight:800;color:#f59e0b" id="tkst-open">—</div>
        </div>
        <div class="stat-card" style="padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">In Progress</div>
          <div style="font-size:28px;font-weight:800;color:#818cf8" id="tkst-progress">—</div>
        </div>
        <div class="stat-card" style="padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Resolved</div>
          <div style="font-size:28px;font-weight:800;color:#34d399" id="tkst-resolved">—</div>
        </div>
        <div class="stat-card" style="padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Urgent Open</div>
          <div style="font-size:28px;font-weight:800;color:#ef4444" id="tkst-urgent">—</div>
        </div>
      </div>
      <!-- Filter row -->
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <select id="tkt-filter-status" class="input" style="width:150px" onchange="loadTickets()">
          <option value="">All Tickets</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
        <select id="tkt-filter-priority" class="input" style="width:140px" onchange="filterTickets()">
          <option value="">All Priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <input type="text" id="tkt-search" class="input" style="width:200px" placeholder="Search tickets..." oninput="filterTickets()">
      </div>
      <!-- Tickets table -->
      <div class="card" style="overflow:hidden">
        <table class="tbl">
          <thead>
            <tr>
              <th>Ticket #</th>
              <th>Subject</th>
              <th>Tenant</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Messages</th>
              <th>Updated</th>
              <th style="text-align:right">Action</th>
            </tr>
          </thead>
          <tbody id="tickets-tbody">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── TAX COMPLIANCE ─────────────────────────────────────────── -->
    <div class="page" id="page-tax" style="padding:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff"><i class="fas fa-file-invoice-dollar" style="color:#818cf8;margin-right:8px"></i>Tax Compliance</h1>
          <p style="color:#64748b;font-size:13px">Wyoming LLC · Canadian-owned · USD→CAD tracking · Form 5472 / T1135 / FBAR</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="tax-year-select" class="input" style="width:100px" onchange="loadTax()">
            <option value="2026">2026</option>
            <option value="2025">2025</option>
            <option value="2024">2024</option>
          </select>
          <button class="btn btn-ghost" onclick="syncStripe()" id="stripe-sync-btn"><i class="fas fa-sync"></i> Sync Stripe</button>
          <button class="btn btn-ghost" onclick="fetchTodayRate()" id="rate-fetch-btn"><i class="fas fa-exchange-alt"></i> Get Today's Rate</button>
          <a id="tax-export-link" class="btn btn-ghost" href="#"><i class="fas fa-download"></i> Export CSV</a>
        </div>
      </div>

      <!-- Alert banners -->
      <div id="tax-alert-t1135" style="display:none;background:#7c2d12;border:1px solid #c2410c;border-radius:10px;padding:12px 16px;margin-bottom:12px;color:#fed7aa;font-size:13px">
        <i class="fas fa-exclamation-triangle" style="margin-right:8px;color:#fb923c"></i>
        <strong>T1135 REQUIRED</strong> — CAD revenue has exceeded $100,000 threshold. You must file T1135 with your Canadian return.
      </div>
      <div id="tax-alert-fbar" style="display:none;background:#1e3a5f;border:1px solid #2563eb;border-radius:10px;padding:12px 16px;margin-bottom:16px;color:#bfdbfe;font-size:13px">
        <i class="fas fa-university" style="margin-right:8px;color:#60a5fa"></i>
        <strong>FBAR ALERT</strong> — US account/revenue exceeds $10,000 USD. FBAR (FinCEN 114) filing required by April 15.
      </div>

      <!-- KPI cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">YTD Revenue (USD)</div>
          <div style="font-size:26px;font-weight:800;color:#34d399" id="tax-ytd-usd">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">Gross (ECI)</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">YTD Revenue (CAD)</div>
          <div style="font-size:26px;font-weight:800;color:#818cf8" id="tax-ytd-cad">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">For CRA reporting</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Stripe Fees (USD)</div>
          <div style="font-size:26px;font-weight:800;color:#f59e0b" id="tax-fees-usd">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">Deductible expense</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Net Income (USD)</div>
          <div style="font-size:26px;font-weight:800;color:#e2e8f0" id="tax-net-usd">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">After refunds + fees</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Today's Rate</div>
          <div style="font-size:26px;font-weight:800;color:#e2e8f0" id="tax-rate-today">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">USD → CAD (BoC)</div>
        </div>
        <div class="stat-card">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:4px">Pending Review</div>
          <div style="font-size:26px;font-weight:800;color:#f87171" id="tax-pending-count">—</div>
          <div style="font-size:11px;color:#475569;margin-top:2px">Unreconciled tx</div>
        </div>
      </div>

      <!-- Threshold progress bars -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:700;color:#e2e8f0"><i class="fas fa-maple-leaf" style="color:#f87171;margin-right:6px"></i>T1135 Threshold (CAD $100K)</span>
            <span style="font-size:12px;color:#94a3b8" id="tax-t1135-label">—</span>
          </div>
          <div style="background:#1e293b;border-radius:20px;height:8px;overflow:hidden">
            <div id="tax-t1135-bar" style="background:#818cf8;height:100%;width:0%;border-radius:20px;transition:width .5s"></div>
          </div>
          <div style="font-size:10px;color:#475569;margin-top:4px">T1135 required if CAD income &gt; $100,000 in calendar year</div>
        </div>
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:12px;font-weight:700;color:#e2e8f0"><i class="fas fa-university" style="color:#60a5fa;margin-right:6px"></i>FBAR Threshold (USD $10K)</span>
            <span style="font-size:12px;color:#94a3b8" id="tax-fbar-label">—</span>
          </div>
          <div style="background:#1e293b;border-radius:20px;height:8px;overflow:hidden">
            <div id="tax-fbar-bar" style="background:#60a5fa;height:100%;width:0%;border-radius:20px;transition:width .5s"></div>
          </div>
          <div style="font-size:10px;color:#475569;margin-top:4px">FBAR required if US account/income exceeded $10,000 USD at any point</div>
        </div>
      </div>

      <!-- Tab pills inside tax page -->
      <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
        <button onclick="showTaxTab('monthly')" id="taxtab-monthly" class="btn btn-primary" style="font-size:12px;padding:6px 14px">Monthly Breakdown</button>
        <button onclick="showTaxTab('ledger')"  id="taxtab-ledger"  class="btn btn-ghost"   style="font-size:12px;padding:6px 14px">Transaction Ledger</button>
        <button onclick="showTaxTab('deadlines')" id="taxtab-deadlines" class="btn btn-ghost" style="font-size:12px;padding:6px 14px">Deadlines</button>
        <button onclick="showTaxTab('forms')"   id="taxtab-forms"   class="btn btn-ghost"   style="font-size:12px;padding:6px 14px">Form Worksheets</button>
        <button onclick="showTaxTab('rates')"   id="taxtab-rates"   class="btn btn-ghost"   style="font-size:12px;padding:6px 14px">Exchange Rates</button>
        <button onclick="showTaxTab('audit')"   id="taxtab-audit"   class="btn btn-ghost"   style="font-size:12px;padding:6px 14px">Audit Log</button>
      </div>

      <!-- MONTHLY BREAKDOWN -->
      <div id="taxtab-monthly-content">
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead>
              <tr style="background:#0c1322">
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Month</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">USD Revenue</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Avg Rate</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">CAD Equivalent</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Transactions</th>
              </tr>
            </thead>
            <tbody id="tax-monthly-tbody">
              <tr><td colspan="5" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- TRANSACTION LEDGER -->
      <div id="taxtab-ledger-content" style="display:none">
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <select id="tax-cat-filter" class="input" style="width:140px" onchange="loadTaxLedger()">
            <option value="">All Categories</option>
            <option value="eci">ECI Revenue</option>
            <option value="fee">Stripe Fees</option>
            <option value="refund">Refunds</option>
            <option value="manual">Manual Entry</option>
          </select>
          <select id="tax-status-filter" class="input" style="width:130px" onchange="loadTaxLedger()">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="reconciled">Reconciled</option>
          </select>
          <button class="btn btn-primary" style="font-size:12px" onclick="showAddTxModal()"><i class="fas fa-plus"></i> Add Manual Entry</button>
        </div>
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead>
              <tr style="background:#0c1322">
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Date</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Description</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Processor</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Category</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">USD</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Rate</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">CAD</th>
                <th style="text-align:center;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Status</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Actions</th>
              </tr>
            </thead>
            <tbody id="tax-ledger-tbody">
              <tr><td colspan="9" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
            </tbody>
          </table>
        </div>
        <div id="tax-ledger-pagination" style="text-align:center;margin-top:12px"></div>
      </div>

      <!-- TAX DEADLINES -->
      <div id="taxtab-deadlines-content" style="display:none">
        <div id="tax-deadlines-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px"></div>
      </div>

      <!-- FORM WORKSHEETS -->
      <div id="taxtab-forms-content" style="display:none">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
          <!-- Form 5472 -->
          <div class="card" style="padding:20px">
            <div style="display:flex;align-items:center;gap-10px;margin-bottom:12px">
              <span style="background:#312e81;color:#a5b4fc;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;margin-right:8px">IRS</span>
              <span style="font-size:15px;font-weight:700;color:#e2e8f0">Form 5472 Worksheet</span>
            </div>
            <p style="font-size:12px;color:#64748b;margin-bottom:12px">Required annually for foreign-owned US LLCs with reportable transactions. Filed with pro-forma Form 1120.</p>
            <div id="form5472-data" style="font-size:13px;color:#94a3b8;line-height:2">Loading...</div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <a id="form5472-csv" class="btn btn-primary" style="font-size:12px" href="#"><i class="fas fa-download"></i> Download CSV</a>
              <a href="https://www.irs.gov/forms-pubs/about-form-5472" target="_blank" class="btn btn-ghost" style="font-size:12px"><i class="fas fa-external-link-alt"></i> IRS Form</a>
            </div>
          </div>
          <!-- T1135 -->
          <div class="card" style="padding:20px">
            <div style="display:flex;align-items:center;gap-10px;margin-bottom:12px">
              <span style="background:#7c2d12;color:#fdba74;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;margin-right:8px">CRA</span>
              <span style="font-size:15px;font-weight:700;color:#e2e8f0">T1135 Worksheet</span>
            </div>
            <p style="font-size:12px;color:#64748b;margin-bottom:12px">Foreign Income Verification. Required if cost of foreign property &gt; CAD $100,000 at any time in the year.</p>
            <div id="formt1135-data" style="font-size:13px;color:#94a3b8;line-height:2">Loading...</div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <a href="https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/t1135.html" target="_blank" class="btn btn-ghost" style="font-size:12px"><i class="fas fa-external-link-alt"></i> CRA Form T1135</a>
            </div>
          </div>
          <!-- FBAR -->
          <div class="card" style="padding:20px">
            <div style="display:flex;align-items:center;gap-10px;margin-bottom:12px">
              <span style="background:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;margin-right:8px">FinCEN</span>
              <span style="font-size:15px;font-weight:700;color:#e2e8f0">FBAR Checklist</span>
            </div>
            <p style="font-size:12px;color:#64748b;margin-bottom:12px">FinCEN Form 114. Required if US account balance exceeded $10,000 USD at any point during the year.</p>
            <div id="fbar-data" style="font-size:13px;color:#94a3b8;line-height:2">Loading...</div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <a href="https://bsaefiling.fincen.treas.gov/main.html" target="_blank" class="btn btn-ghost" style="font-size:12px"><i class="fas fa-external-link-alt"></i> File FBAR (FinCEN)</a>
            </div>
          </div>
          <!-- Treaty Summary -->
          <div class="card" style="padding:20px">
            <div style="display:flex;align-items:center;gap-10px;margin-bottom:12px">
              <span style="background:#14532d;color:#86efac;font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;margin-right:8px">TREATY</span>
              <span style="font-size:15px;font-weight:700;color:#e2e8f0">Canada-US Tax Treaty</span>
            </div>
            <div style="font-size:12px;color:#94a3b8;line-height:1.8">
              <div>✅ <strong style="color:#e2e8f0">ECI Income:</strong> Taxed in the US at regular rates — treaty reduces withholding</div>
              <div>✅ <strong style="color:#e2e8f0">SaaS Revenue:</strong> Generally classified as ECI (business income)</div>
              <div>✅ <strong style="color:#e2e8f0">Withholding Rate:</strong> Reduced from 30% → 0% for ECI with ITIN/W-8BEN-E</div>
              <div>✅ <strong style="color:#e2e8f0">Foreign Tax Credit:</strong> US taxes paid can offset Canadian taxes owing</div>
              <div>⚠️ <strong style="color:#fcd34d">ITIN Required:</strong> Apply via Form W-7 if not already obtained</div>
            </div>
          </div>
        </div>
      </div>

      <!-- EXCHANGE RATES -->
      <div id="taxtab-rates-content" style="display:none">
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
          <span style="font-size:13px;color:#94a3b8">Manual override:</span>
          <input type="date" id="rate-manual-date" class="input" style="width:150px">
          <input type="number" id="rate-manual-val" class="input" step="0.0001" placeholder="e.g. 1.3650" style="width:130px">
          <button class="btn btn-primary" style="font-size:12px" onclick="saveManualRate()"><i class="fas fa-save"></i> Save Rate</button>
        </div>
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead>
              <tr style="background:#0c1322">
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Date</th>
                <th style="text-align:right;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">USD/CAD Rate</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Source</th>
              </tr>
            </thead>
            <tbody id="tax-rates-tbody">
              <tr><td colspan="3" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- AUDIT LOG -->
      <div id="taxtab-audit-content" style="display:none">
        <div style="overflow-x:auto">
          <table class="tbl">
            <thead>
              <tr style="background:#0c1322">
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Timestamp</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Action</th>
                <th style="text-align:left;padding:10px 12px;color:#64748b;font-size:11px;font-weight:700;text-transform:uppercase">Details</th>
              </tr>
            </thead>
            <tbody id="tax-audit-tbody">
              <tr><td colspan="3" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- /page-tax -->

    <!-- ── TRIAL LINKS (inside #content) ─────────────────────────────── -->
    <div class="page" id="page-trial-links" style="padding:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff"><i class="fas fa-link" style="color:#818cf8;margin-right:8px"></i>Trial Links</h1>
          <p style="color:#64748b;font-size:13px">Generate shareable links for prospects — 60-day free trial, no credit card required</p>
        </div>
      </div>

      <!-- Quick copy card -->
      <div class="card" style="padding:20px;margin-bottom:20px;background:linear-gradient(135deg,#1e1b4b,#0f172a);border-color:#312e81">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <div style="background:#4f46e5;border-radius:8px;padding:8px 12px">
            <i class="fas fa-rocket" style="color:#a5b4fc;font-size:16px"></i>
          </div>
          <div>
            <div style="font-weight:700;color:#fff">Standard Free-Trial Link</div>
            <div style="font-size:12px;color:#64748b">Works anywhere — email, SMS, LinkedIn, landing page</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;background:#0f172a;border:1px solid #312e81;border-radius:8px;padding:10px 14px;margin-bottom:12px">
          <i class="fas fa-link" style="color:#4f46e5;flex-shrink:0"></i>
          <span id="trial-link-url" style="flex:1;color:#a5b4fc;font-size:13px;word-break:break-all">https://clockinproof.pages.dev/free-trial</span>
          <button class="btn btn-primary" style="padding:5px 14px;font-size:12px;flex-shrink:0" onclick="copyTrialLink()"><i class="fas fa-copy"></i> Copy</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="https://clockinproof.pages.dev/free-trial" target="_blank" class="btn btn-ghost" style="font-size:12px">
            <i class="fas fa-eye"></i> Preview
          </a>
          <button class="btn btn-ghost" style="font-size:12px" onclick="genEmailSnippet()">
            <i class="fas fa-envelope"></i> Email Snippet
          </button>
          <button class="btn btn-ghost" style="font-size:12px" onclick="genSmsSnippet()">
            <i class="fas fa-sms"></i> SMS Text
          </button>
        </div>
      </div>

      <!-- UTM Link Generator -->
      <div class="card" style="padding:20px;margin-bottom:20px">
        <h3 style="font-size:14px;font-weight:700;color:#fff;margin-bottom:14px"><i class="fas fa-sliders-h" style="color:#818cf8;margin-right:6px"></i>UTM Tracking Generator</h3>
        <p style="font-size:12px;color:#64748b;margin-bottom:14px">Create tagged links to track where sign-ups come from</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div>
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Source</label>
            <input id="utm-source" class="input" placeholder="google, linkedin, email" />
          </div>
          <div>
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Medium</label>
            <input id="utm-medium" class="input" placeholder="cpc, email, social" />
          </div>
          <div>
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Campaign</label>
            <input id="utm-campaign" class="input" placeholder="spring2026, roofing-promo" />
          </div>
          <div>
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Content (optional)</label>
            <input id="utm-content" class="input" placeholder="banner-ad, cta-button" />
          </div>
        </div>
        <button class="btn btn-primary" onclick="buildUtmLink()" style="margin-bottom:12px"><i class="fas fa-magic"></i> Generate Link</button>
        <div id="utm-result" style="display:none;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px">
          <div style="display:flex;align-items:center;gap:8px">
            <span id="utm-link-out" style="flex:1;color:#a5b4fc;font-size:12px;word-break:break-all"></span>
            <button class="btn btn-primary" style="padding:4px 12px;font-size:12px;flex-shrink:0" onclick="copyUtmLink()"><i class="fas fa-copy"></i></button>
          </div>
        </div>
      </div>

      <!-- Snippet modal -->
      <div id="snippet-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:300;align-items:center;justify-content:center;padding:16px">
        <div class="card" style="padding:24px;width:100%;max-width:600px;position:relative;max-height:90vh;display:flex;flex-direction:column">
          <button onclick="document.getElementById('snippet-modal').style.display='none'" style="position:absolute;top:12px;right:16px;background:none;border:none;color:#64748b;font-size:18px;cursor:pointer">&#x2715;</button>
          <h3 id="snippet-title" style="font-size:15px;font-weight:700;color:#fff;margin-bottom:6px">Snippet</h3>
          <p style="font-size:11px;color:#64748b;margin-bottom:10px">Edit as needed, then copy — placeholders like [Name] are for you to fill in.</p>
          <textarea id="snippet-text" onclick="this.select()" style="flex:1;min-height:260px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:12px;font-size:12px;line-height:1.7;resize:vertical;font-family:monospace" readonly></textarea>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-ghost" style="flex:1;font-size:12px" onclick="document.getElementById('snippet-text').select()"><i class="fas fa-mouse-pointer"></i> Select All</button>
            <button class="btn btn-primary" style="flex:2" onclick="copySnippet()"><i class="fas fa-copy"></i> Copy to Clipboard</button>
          </div>
        </div>
      </div>

      <!-- Recent trial sign-ups -->
      <div class="card" style="padding:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="font-size:14px;font-weight:700;color:#fff"><i class="fas fa-users" style="color:#818cf8;margin-right:6px"></i>Recent Trial Sign-Ups</h3>
          <button class="btn btn-ghost" style="font-size:11px" onclick="loadTrialSignups()"><i class="fas fa-sync"></i> Refresh</button>
        </div>
        <div id="trial-signups-list">
          <div style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></div>
        </div>
      </div>
    </div>

    <!-- ── SIGNUP LEADS ─────────────────────────────────────────────────── -->
    <div class="page" id="page-leads" style="padding:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
        <div>
          <h1 style="font-size:20px;font-weight:800;color:#fff"><i class="fas fa-user-plus" style="color:#818cf8;margin-right:8px"></i>Signup Leads</h1>
          <p style="color:#64748b;font-size:13px">Everyone who started the free-trial flow — verified or not, converted or abandoned</p>
        </div>
        <button class="btn btn-ghost" style="font-size:12px" onclick="loadLeads()"><i class="fas fa-sync"></i> Refresh</button>
      </div>

      <!-- Stats row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        <div class="stat-card" style="padding:16px">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;font-weight:700;margin-bottom:4px">Total Leads</div>
          <div id="leads-stat-total" style="font-size:24px;font-weight:800;color:#fff">—</div>
        </div>
        <div class="stat-card" style="padding:16px">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;font-weight:700;margin-bottom:4px">Verified</div>
          <div id="leads-stat-verified" style="font-size:24px;font-weight:800;color:#818cf8">—</div>
        </div>
        <div class="stat-card" style="padding:16px">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;font-weight:700;margin-bottom:4px">Converted</div>
          <div id="leads-stat-converted" style="font-size:24px;font-weight:800;color:#4ade80">—</div>
        </div>
        <div class="stat-card" style="padding:16px">
          <div style="font-size:11px;color:#475569;text-transform:uppercase;font-weight:700;margin-bottom:4px">Abandoned</div>
          <div id="leads-stat-abandoned" style="font-size:24px;font-weight:800;color:#f87171">—</div>
        </div>
      </div>

      <!-- Filter tabs -->
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        <button class="btn btn-primary" id="leads-filter-all" onclick="setLeadsFilter('all')" style="font-size:11px;padding:5px 12px">All</button>
        <button class="btn btn-ghost" id="leads-filter-abandoned" onclick="setLeadsFilter('abandoned')" style="font-size:11px;padding:5px 12px">Abandoned</button>
        <button class="btn btn-ghost" id="leads-filter-verified" onclick="setLeadsFilter('verified')" style="font-size:11px;padding:5px 12px">Verified Only</button>
        <button class="btn btn-ghost" id="leads-filter-converted" onclick="setLeadsFilter('converted')" style="font-size:11px;padding:5px 12px">Converted</button>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div id="leads-table" style="overflow-x:auto">
          <div style="text-align:center;padding:48px;color:#475569"><i class="fas fa-spinner fa-spin"></i></div>
        </div>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /app -->

<!-- ══════════════════════════════════════════════════════════════════
     TAX PAGE — injected outside #app so it overlays full viewport
     ══════════════════════════════════════════════════════════════════ -->

<!-- TICKET DETAIL MODAL -->
<div class="modal-bg" id="ticket-modal" onclick="if(event.target===this)closeTicketModal()">
  <div class="card" style="padding:0;width:100%;max-width:700px;max-height:92vh;display:flex;flex-direction:column">
    <!-- Modal header -->
    <div style="padding:18px 20px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-family:monospace;background:#0f172a;color:#818cf8;padding:3px 10px;border-radius:6px;font-size:13px" id="tkt-modal-number">—</span>
          <span id="tkt-modal-status-badge"></span>
          <span id="tkt-modal-priority-badge"></span>
        </div>
        <h3 style="font-size:16px;font-weight:700;color:#fff;margin-top:6px" id="tkt-modal-subject">—</h3>
        <p style="font-size:12px;color:#475569;margin-top:2px" id="tkt-modal-meta">—</p>
      </div>
      <button onclick="closeTicketModal()" style="background:none;border:none;color:#64748b;font-size:22px;cursor:pointer;flex-shrink:0;line-height:1">&times;</button>
    </div>
    <!-- Toolbar -->
    <div style="padding:10px 20px;border-bottom:1px solid #1e293b;display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:#0f172a">
      <select id="tkt-status-select" class="input" style="width:160px;font-size:12px;padding:5px 10px">
        <option value="open">Open</option>
        <option value="in_progress">In Progress</option>
        <option value="resolved">Resolved</option>
        <option value="closed">Closed</option>
      </select>
      <select id="tkt-priority-select" class="input" style="width:130px;font-size:12px;padding:5px 10px">
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </select>
      <button class="btn btn-ghost" onclick="updateTicketStatus()" style="font-size:12px"><i class="fas fa-save"></i> Update Status</button>
      <button class="btn btn-success" onclick="resolveAndClose()" style="font-size:12px"><i class="fas fa-check"></i> Resolve &amp; Close</button>
    </div>
    <!-- Thread -->
    <div id="tkt-thread" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px">
      <div style="text-align:center;color:#475569"><i class="fas fa-spinner fa-spin"></i></div>
    </div>
    <!-- Reply box -->
    <div style="padding:14px 20px;border-top:1px solid #334155;flex-shrink:0">
      <textarea id="tkt-reply-text" class="input" rows="3"
        style="resize:vertical;margin-bottom:10px;font-family:inherit"
        placeholder="Type your reply to the tenant..."></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#64748b;cursor:pointer">
          <input type="checkbox" id="tkt-internal-note" style="width:13px;height:13px">
          Internal note (not emailed to tenant)
        </label>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" onclick="closeTicketModal()">Cancel</button>
          <button class="btn btn-primary" onclick="sendTicketReply()"><i class="fas fa-paper-plane"></i> Send Reply</button>
        </div>
      </div>
    </div>
  </div>

<!-- TENANT PROFILE DRAWER -->
<div id="tenant-profile-overlay" onclick="closeTenantProfile()" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200"></div>
<div id="tenant-profile-drawer" style="display:none;position:fixed;top:0;right:0;width:min(680px,100vw);height:100vh;background:#0f172a;border-left:1px solid #1e293b;z-index:201;overflow-y:auto;box-shadow:-8px 0 40px rgba(0,0,0,0.5)">
  <!-- Header -->
  <div style="padding:20px 24px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:12px;position:sticky;top:0;background:#0f172a;z-index:10">
    <div id="tp-logo" style="width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#fff;flex-shrink:0;background:#4f46e5">?</div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <h2 id="tp-name" style="font-size:18px;font-weight:700;color:#fff;margin:0">Loading...</h2>
        <span id="tp-status-badge" class="pill">—</span>
        <span id="tp-plan-badge" class="pill">—</span>
      </div>
      <div id="tp-meta" style="color:#64748b;font-size:12px;margin-top:2px">—</div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <a id="tp-admin-link" href="#" target="_blank" class="btn btn-ghost" title="Open Tenant Admin Panel" style="font-size:11px"><i class="fas fa-external-link-alt"></i> Admin</a>
      <a id="tp-app-link" href="#" target="_blank" class="btn btn-ghost" title="Worker App" style="font-size:11px"><i class="fas fa-mobile-alt"></i> App</a>
      <button onclick="closeTenantProfile()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:18px;padding:4px 8px">✕</button>
    </div>
  </div>

  <!-- Body -->
  <div id="tp-body" style="padding:20px 24px">
    <div style="text-align:center;padding:60px;color:#475569"><i class="fas fa-spinner fa-spin"></i> Loading tenant profile...</div>
  </div>
</div>

<!-- EDIT TENANT MODAL -->
<div class="modal-bg" id="edit-modal" onclick="if(event.target===this)closeEditModal()">
  <div class="card" style="padding:24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
      <h3 style="font-size:16px;font-weight:700;color:#fff">Edit Tenant</h3>
      <button onclick="closeEditModal()" style="background:none;border:none;color:#64748b;font-size:20px;cursor:pointer;line-height:1">&times;</button>
    </div>
    <input type="hidden" id="edit-tenant-id">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Company Name</label>
        <input type="text" id="edit-company" class="input">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Admin Email</label>
        <input type="email" id="edit-email" class="input">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Admin PIN</label>
          <input type="text" id="edit-pin" class="input" maxlength="8">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Brand Color</label>
          <input type="color" id="edit-color" class="input" style="height:40px;cursor:pointer;padding:4px">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Plan</label>
          <select id="edit-plan" class="input">
            <option value="">Loading plans…</option>
          </select>
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Status</label>
          <select id="edit-status" class="input">
            <option value="active">Active</option>
            <option value="trial">Trial</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Max Workers Override</label>
        <input type="number" id="edit-max-workers" class="input" min="1">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;margin-bottom:6px">Company Address</label>
        <input type="text" id="edit-address" class="input">
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn btn-primary" onclick="saveTenant()" style="flex:1;justify-content:center"><i class="fas fa-save"></i> Save Changes</button>
      <button class="btn btn-ghost" onclick="closeEditModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- DELETE TENANT CONFIRMATION MODAL -->
<div class="modal-bg" id="delete-modal" onclick="if(event.target===this)closeDeleteModal()">
  <div class="card" style="padding:28px;width:100%;max-width:460px">
    <div style="text-align:center;margin-bottom:20px">
      <div style="width:56px;height:56px;background:#fee2e2;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 14px">
        <i class="fas fa-trash" style="color:#ef4444;font-size:22px"></i>
      </div>
      <h3 style="font-size:17px;font-weight:700;color:#fff;margin:0 0 8px">Archive Tenant?</h3>
      <p id="delete-modal-desc" style="font-size:13px;color:#94a3b8;margin:0">This tenant and all their data will be archived. Workers will not be able to clock in.</p>
    </div>
    <div style="background:#1e293b;border-radius:8px;padding:14px;margin-bottom:20px;font-size:12px;color:#cbd5e1;border-left:3px solid #ef4444">
      <strong style="color:#f87171">⚠ 90-Day Guardrail.</strong> The company, workers, sessions and GPS data move to the <strong>Archive tab</strong>. Everything is fully preserved and restorable for 90 days. After 90 days all data is permanently purged.
    </div>
    <div style="margin-bottom:16px">
      <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#ef4444;margin-bottom:6px">Type the company name to confirm</label>
      <input id="delete-confirm-input" type="text" class="input" placeholder="Type exact company name…" oninput="checkDeleteConfirm()">
      <p id="delete-name-hint" style="font-size:11px;color:#64748b;margin-top:4px"></p>
    </div>
    <div style="display:flex;gap:12px">
      <button class="btn btn-ghost" style="flex:1" onclick="closeDeleteModal()">Cancel</button>
      <button id="delete-confirm-btn" class="btn btn-danger" style="flex:1;opacity:.4;pointer-events:none" onclick="executeDeleteTenant()">
        <i class="fas fa-trash" style="margin-right:6px"></i>Archive Tenant
      </button>
    </div>
    <div id="delete-result" style="display:none;margin-top:14px;padding:10px 14px;border-radius:8px;font-size:13px;text-align:center"></div>
  </div>
</div>

<!-- TOAST -->
<div id="toast"></div>

<script>
'use strict'
let superToken = localStorage.getItem('super_token') || ''
let allTenants = []
let sessPage = 1
const sessLimit = 50

// ── Auth ──────────────────────────────────────────────────────────────────────
async function doSuperLogin() {
  const pin = document.getElementById('super-pin').value.trim()
  if (!pin) {
    const el = document.getElementById('login-error')
    el.textContent = 'Please enter your PIN'
    el.style.display = 'block'
    return
  }
  const btn = document.getElementById('login-btn')
  const errEl = document.getElementById('login-error')
  errEl.style.display = 'none'
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying…'
  try {
    const r = await fetch('/api/super/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    })
    const d = await r.json()
    if (!r.ok || d.error) {
      errEl.textContent = d.error || 'Invalid PIN — please try again'
      errEl.style.display = 'block'
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-unlock-keyhole"></i> Access Portal'
      // shake the input
      const inp = document.getElementById('super-pin')
      inp.style.transition = 'transform 0.1s'
      inp.style.border = '1px solid #dc2626'
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 60))
        inp.style.transform = 'translateX(6px)'
        await new Promise(r => setTimeout(r, 60))
        inp.style.transform = 'translateX(-6px)'
      }
      inp.style.transform = ''
      return
    }
    superToken = d.token
    localStorage.setItem('super_token', superToken)
    btn.innerHTML = '<i class="fas fa-check"></i> Access Granted'
    await new Promise(r => setTimeout(r, 400))
    showApp()
  } catch(e) {
    errEl.textContent = 'Connection error — check your internet and try again'
    errEl.style.display = 'block'
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-unlock-keyhole"></i> Access Portal'
  }
}
document.getElementById('super-pin').addEventListener('keydown', e => { if(e.key==='Enter') doSuperLogin() })

function doLogout() {
  localStorage.removeItem('super_token')
  superToken = ''
  document.getElementById('app').style.display = 'none'
  document.getElementById('login-screen').style.display = 'flex'
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none'
  document.getElementById('app').style.display = 'grid'
  loadOverview()
  loadLiveBadge()
  // populate tenant filter for sessions
  api('/api/super/tenants').then(d => {
    const sel = document.getElementById('sess-tenant-filter')
    ;(d.tenants||[]).forEach(t => {
      const o = document.createElement('option')
      o.value = t.id; o.textContent = t.company_name
      sel.appendChild(o)
    })
  }).catch(()=>{})
  // pre-populate plan dropdowns in Add Tenant and Edit Tenant modals
  api('/api/super/plans').then(d => {
    _plansData = d.plans || []
    populatePlanDropdowns(_plansData, null)
  }).catch(()=>{})
}

if (superToken) showApp()

// ── API helper ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Super-Token': superToken, ...(opts.headers||{}) }
  })
  if (r.status === 401) { doLogout(); throw new Error('Unauthorized') }
  return r.json()
}

// ── Page navigation ────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'))
  document.getElementById('page-' + name)?.classList.add('active')
  document.getElementById('nav-' + name)?.classList.add('active')
  // Auto-close sidebar on mobile after selecting a tab
  closeSidebar()
  // Load data on demand
  if (name === 'overview')    loadOverview()
  if (name === 'live')        loadLive()
  if (name === 'tenants')     loadTenants()
  if (name === 'sessions')    loadSessions()
  if (name === 'revenue')     loadRevenue()
  if (name === 'support')     loadTickets()
  if (name === 'platform')    loadPlatformUrls()
  if (name === 'tax')         loadTax()
  if (name === 'plans')       loadPlansPage()
  if (name === 'trial-links') loadTrialSignups()
  if (name === 'leads')       loadLeads()
}

// ── LEADS ─────────────────────────────────────────────────────────────────────
let _allLeads = []
let _leadsFilter = 'all'

function setLeadsFilter(f) {
  _leadsFilter = f
  ;['all','abandoned','verified','converted'].forEach(k => {
    const el = document.getElementById('leads-filter-' + k)
    if (el) { el.className = k === f ? 'btn btn-primary' : 'btn btn-ghost'; el.style.fontSize='11px'; el.style.padding='5px 12px' }
  })
  renderLeads()
}

async function loadLeads() {
  document.getElementById('leads-table').innerHTML = '<div style="text-align:center;padding:48px;color:#475569"><i class="fas fa-spinner fa-spin"></i></div>'
  try {
    const r = await fetch('/api/super/leads', { headers: { 'X-Super-Token': superToken } })
    const d = await r.json()
    _allLeads = d.leads || []
    // Update stats
    const total = _allLeads.length
    const verified = _allLeads.filter(l => l.code_verified && !l.converted).length
    const converted = _allLeads.filter(l => l.converted).length
    const abandoned = _allLeads.filter(l => !l.code_verified && !l.converted).length
    document.getElementById('leads-stat-total').textContent = total
    document.getElementById('leads-stat-verified').textContent = verified
    document.getElementById('leads-stat-converted').textContent = converted
    document.getElementById('leads-stat-abandoned').textContent = abandoned
    // Badge
    const badge = document.getElementById('leads-badge')
    if (abandoned > 0) { badge.textContent = abandoned; badge.style.display = 'inline-block' } else { badge.style.display = 'none' }
    renderLeads()
  } catch(e) {
    document.getElementById('leads-table').innerHTML = '<div style="text-align:center;padding:48px;color:#475569">Failed to load</div>'
  }
}

function renderLeads() {
  let list = _allLeads
  if (_leadsFilter === 'abandoned') list = list.filter(l => !l.code_verified && !l.converted)
  if (_leadsFilter === 'verified')  list = list.filter(l => l.code_verified && !l.converted)
  if (_leadsFilter === 'converted') list = list.filter(l => l.converted)
  if (!list.length) {
    document.getElementById('leads-table').innerHTML = '<div class="empty-state" style="padding:48px"><i class="fas fa-user-clock"></i><p>No leads in this category</p></div>'
    return
  }
  const rows = list.map(function(l) {
    const statusHtml = l.converted
      ? '<span class="pill badge-active">converted</span>'
      : l.code_verified
        ? '<span class="pill" style="background:#1e3a5f;color:#93c5fd">verified</span>'
        : '<span class="pill badge-suspended">abandoned</span>'
    const ago = l.created_at ? timeSince(new Date(l.created_at)) : '—'
    const utmHtml = l.utm_source ? '<span style="color:#818cf8;font-size:11px">' + l.utm_source + (l.utm_campaign ? ' / ' + l.utm_campaign : '') + '</span>' : '<span style="color:#334155;font-size:11px">direct</span>'
    return '<tr>' +
      '<td style="font-weight:600;color:#e2e8f0">' + (l.company_name || '—') + '</td>' +
      '<td style="color:#94a3b8">' + l.email + '</td>' +
      '<td style="color:#94a3b8">' + (l.phone || '—') + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td>' + utmHtml + '</td>' +
      '<td style="color:#64748b;font-size:12px">' + ago + '</td>' +
      '<td>' + (l.converted && l.tenant_company ? '<span style="color:#4ade80;font-size:12px">' + l.tenant_company + '</span>' : '—') + '</td>' +
    '</tr>'
  }).join('')
  document.getElementById('leads-table').innerHTML =
    '<table class="tbl"><thead><tr>' +
    '<th>Company</th><th>Email</th><th>Phone</th><th>Status</th><th>Source</th><th>When</th><th>Account</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>'
}

function timeSince(date) {
  const s = Math.floor((Date.now() - date) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.floor(s/60) + 'm ago'
  if (s < 86400) return Math.floor(s/3600) + 'h ago'
  return Math.floor(s/86400) + 'd ago'
}

// ── TRIAL LINKS ──────────────────────────────────────────────────────────
const TRIAL_BASE = 'https://clockinproof.pages.dev/free-trial'

function copyTrialLink() {
  navigator.clipboard.writeText(TRIAL_BASE).then(() => showToast('✅ Link copied!'))
}

function buildUtmLink() {
  const src = document.getElementById('utm-source').value.trim()
  const med = document.getElementById('utm-medium').value.trim()
  const cam = document.getElementById('utm-campaign').value.trim()
  const con = document.getElementById('utm-content').value.trim()
  if (!src && !med && !cam) { showToast('⚠️ Fill in at least one UTM field'); return }
  const params = new URLSearchParams()
  if (src) params.set('utm_source', src)
  if (med) params.set('utm_medium', med)
  if (cam) params.set('utm_campaign', cam)
  if (con) params.set('utm_content', con)
  const link = TRIAL_BASE + '?' + params.toString()
  document.getElementById('utm-link-out').textContent = link
  document.getElementById('utm-result').style.display = 'block'
}

function copyUtmLink() {
  const txt = document.getElementById('utm-link-out').textContent
  navigator.clipboard.writeText(txt).then(() => showToast('✅ UTM link copied!'))
}

function genEmailSnippet() {
  const link = TRIAL_BASE
  const lines = [
    'Subject: Try ClockInProof free for 60 days \u2014 no credit card',
    '',
    'Hi [First Name],',
    '',
    "I came across a tool I think would be a great fit for your team \u2014 it\'s called ClockInProof.",
    '',
    'It gives field crews a simple GPS clock-in app, and gives owners real-time proof of work:',
    '  \u2022 GPS-verified clock-in/out on any phone',
    '  \u2022 Geofence fraud detection (alerts if workers clock in from the wrong location)',
    '  \u2022 Job dispatch via SMS',
    '  \u2022 Automated payroll reports',
    '',
    'No hardware. No app store installs needed. Workers just tap a link.',
    '',
    'Start a free 60-day trial \u2014 no credit card required:',
    link,
    '',
    'Takes about 2 minutes to set up. Let me know if you have any questions.',
    '',
    'Best,',
    '[Your Name]'
  ]
  const txt = lines.join('\n')
  document.getElementById('snippet-title').textContent = 'Email Snippet'
  document.getElementById('snippet-text').value = txt
  document.getElementById('snippet-modal').style.display = 'flex'
}

function genSmsSnippet() {
  const txt = 'Hey [Name]! Quick one \u2014 have you tried ClockInProof? GPS time tracking for field crews, automated payroll, no credit card. Free 60-day trial: ' + TRIAL_BASE + ' \u2014 takes 2 min to set up.'
  document.getElementById('snippet-title').textContent = 'SMS Text'
  document.getElementById('snippet-text').value = txt
  document.getElementById('snippet-modal').style.display = 'flex'
}

function copySnippet() {
  const txt = document.getElementById('snippet-text').value
  navigator.clipboard.writeText(txt).then(() => showToast('✅ Copied!'))
}

async function loadTrialSignups() {
  const el = document.getElementById('trial-signups-list')
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#475569"><i class="fas fa-spinner fa-spin"></i></div>'
  try {
    const r = await fetch('/api/tenants?status=trial&limit=20', { headers: { 'X-Super-Admin': 'true' } })
    const data = await r.json()
    const tenants = data.tenants || data || []
    // Exclude archived/deleted tenants from trial sign-ups list
    const trials = tenants.filter(t => (t.status === 'trial' || t.plan === 'trial') && t.status !== 'archived' && t.status !== 'deleted')
    if (!trials.length) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-user-clock"></i><p>No trial sign-ups yet</p><p style="font-size:12px;margin-top:4px">Share the link above to get started</p></div>'
      return
    }
    const rows = trials.map(function(t) {
      const days = t.trial_ends_at ? Math.ceil((new Date(t.trial_ends_at) - Date.now()) / 86400000) : '?'
      const daysColor = days < 7 ? '#ef4444' : days < 14 ? '#f59e0b' : '#22c55e'
      const daysLabel = (typeof days === 'number' && days > 0) ? (days + ' days left') : 'Expired'
      return '<tr>' +
        '<td style="font-weight:600;color:#e2e8f0">' + t.company_name + '</td>' +
        '<td><span style="color:#818cf8">' + t.slug + '.clockinproof.com</span></td>' +
        '<td style="color:#94a3b8">' + t.admin_email + '</td>' +
        '<td><span style="color:' + daysColor + ';font-weight:600">' + daysLabel + '</span></td>' +
        '<td style="text-align:center">' + (t.worker_count || '\u2014') + '</td>' +
        '<td><span class="pill badge-trial">trial</span></td>' +
        '</tr>'
    }).join('')
    el.innerHTML = '<table class="tbl"><thead><tr>' +
      '<th>Company</th><th>Subdomain</th><th>Email</th><th>Trial Ends</th><th>Workers</th><th>Status</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>'
  } catch(e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Failed to load</p></div>'
  }
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar')
  const ov = document.getElementById('sidebar-overlay')
  const isOpen = sb.classList.contains('open')
  if (isOpen) {
    sb.classList.remove('open')
    ov.style.display = 'none'
  } else {
    sb.classList.add('open')
    ov.style.display = 'block'
  }
}

function closeSidebar() {
  // Only close on mobile (sidebar is position:fixed when open)
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open')
    document.getElementById('sidebar-overlay').style.display = 'none'
  }
}

function refreshCurrent() {
  const active = document.querySelector('.page.active')
  if (!active) return
  const name = active.id.replace('page-','')
  showPage(name)
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString()
}

// ── Overview ───────────────────────────────────────────────────────────────
async function loadOverview() {
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString()
  try {
    const [dash, td] = await Promise.all([
      api('/api/super/dashboard'),
      api('/api/super/tenants')
    ])
    document.getElementById('ov-tenants').textContent  = dash.total_tenants  || 0
    document.getElementById('ov-workers').textContent  = dash.total_workers  || 0
    document.getElementById('ov-live').textContent     = dash.active_sessions || 0
    document.getElementById('ov-sessions').textContent = dash.total_sessions || 0
    document.getElementById('live-count-badge').textContent = dash.active_sessions || 0
    // Plan breakdown
    const planColors = { starter:'badge-starter', growth:'badge-growth', pro:'badge-pro' }
    document.getElementById('ov-plans').innerHTML = (dash.plan_breakdown||[]).length
      ? (dash.plan_breakdown||[]).map(p => \`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:#0f172a;border-radius:6px">
            <span class="pill \${planColors[p.plan]||'badge-starter'}">\${(p.plan||'—').toUpperCase()}</span>
            <span style="font-size:18px;font-weight:800;color:#fff">\${p.count}</span>
          </div>\`).join('')
      : '<span style="color:#475569;font-size:13px">No tenants</span>'
    // Recent tenants
    allTenants = td.tenants || []
    document.getElementById('ov-recent').innerHTML = allTenants.slice(0,5).map(t => \`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#0f172a;border-radius:8px">
        <div>
          <span style="font-weight:600;color:#e2e8f0;font-size:13px">\${t.company_name}</span>
          <span style="color:#475569;font-size:11px;margin-left:6px">\${t.slug}.clockinproof.com</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="pill \${t.plan==='pro'?'badge-pro':t.plan==='growth'?'badge-growth':'badge-starter'}">\${t.plan||'starter'}</span>
          <span class="pill \${t.status==='active'?'badge-active':t.status==='trial'?'badge-trial':'badge-suspended'}">\${t.status}</span>
        </div>
      </div>\`).join('') || '<span style="color:#475569;font-size:13px">No tenants yet</span>'
  } catch(e) { console.error(e) }
}

// ── Live Activity ──────────────────────────────────────────────────────────
async function loadLiveBadge() {
  try {
    const d = await api('/api/super/live')
    document.getElementById('live-count-badge').textContent = d.count || 0
  } catch {}
}

async function loadLive() {
  const tbody = document.getElementById('live-tbody')
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  try {
    const d = await api('/api/super/live')
    const rows = d.sessions || []
    document.getElementById('live-count-badge').textContent = rows.length
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:48px;color:#475569"><i class="fas fa-moon" style="font-size:28px;display:block;margin-bottom:8px"></i>No workers clocked in right now</td></tr>'
      return
    }
    tbody.innerHTML = rows.map(s => {
      const cin = new Date(s.clock_in_time)
      const dur = Math.round((Date.now() - cin.getTime()) / 60000)
      const h = Math.floor(dur/60), m = dur%60
      return \`<tr>
        <td><span style="font-weight:600;color:#e2e8f0">\${s.worker_name}</span></td>
        <td><a href="https://\${s.tenant_slug}.clockinproof.com" target="_blank" style="color:#818cf8;font-size:12px">\${s.company_name}</a></td>
        <td style="color:#94a3b8;font-size:12px">\${cin.toLocaleTimeString()}</td>
        <td><span class="live-dot" style="margin-right:4px"></span><span style="color:#34d399;font-weight:600">\${h}h \${m}m</span></td>
        <td style="color:#94a3b8;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${s.clock_in_address||s.job_location||'—'}</td>
      </tr>\`
    }).join('')
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:#ef4444">Failed to load live data</td></tr>'
  }
}

// ── Tenants ────────────────────────────────────────────────────────────────
async function loadTenants() {
  const tbody = document.getElementById('tenants-tbody')
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  try {
    const d = await api('/api/super/tenants')
    allTenants = d.tenants || []
    renderTenants(allTenants)
    // Also refresh archive badge count
    api('/api/super/tenants/archived').then(data => {
      const badge = document.getElementById('archived-count-badge')
      if (badge) {
        const count = (data.tenants || []).length
        badge.textContent = count; badge.style.display = count > 0 ? 'inline' : 'none'
      }
    }).catch(() => {})
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#ef4444">Failed to load</td></tr>'
  }
}

function filterTenants() {
  const q = document.getElementById('tenant-search').value.toLowerCase()
  const fs = document.getElementById('tenant-filter-status').value
  const fp = document.getElementById('tenant-filter-plan').value
  renderTenants(allTenants.filter(t =>
    (!q || t.company_name.toLowerCase().includes(q) || t.slug.includes(q) || (t.admin_email||'').toLowerCase().includes(q)) &&
    (!fs || t.status === fs) && (!fp || t.plan === fp)
  ))
}

function renderTenants(tenants) {
  document.getElementById('tenant-count-label').textContent = tenants.length + ' tenant' + (tenants.length!==1?'s':'')
  const tbody = document.getElementById('tenants-tbody')
  if (!tenants.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#475569">No tenants found</td></tr>'
    return
  }
  tbody.innerHTML = tenants.map(t => {
    const sc = t.status==='active'?'badge-active':t.status==='trial'?'badge-trial':'badge-suspended'
    const pc = t.plan==='pro'?'badge-pro':t.plan==='growth'?'badge-growth':'badge-starter'
    const la = t.last_active ? new Date(t.last_active).toLocaleDateString() : 'Never'
    const cr = t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'
    return \`<tr style="cursor:pointer" onclick="openTenantProfile(\${t.id})">
      <td>
        <div style="font-weight:600;color:#e2e8f0">\${t.company_name}</div>
        <div style="color:#475569;font-size:11px">\${t.admin_email||'—'}</div>
        <div style="color:#334155;font-size:10px">Created \${cr}</div>
      </td>
      <td><span style="color:#818cf8;font-size:12px">\${t.slug}</span></td>
      <td><span class="pill \${pc}">\${t.plan||'starter'}</span></td>
      <td><span class="pill \${sc}">\${t.status}</span></td>
      <td style="color:#94a3b8">\${t.worker_count||0} / \${t.max_workers||'?'}</td>
      <td style="color:#94a3b8">\${t.session_count||0}</td>
      <td style="color:#64748b;font-size:12px">\${la}</td>
      <td style="text-align:right" onclick="event.stopPropagation()">
        <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick='openEditModal(\${JSON.stringify(t).replace(/'/g,"&#39;")})' title="Edit"><i class="fas fa-edit"></i></button>
          <a href="https://admin.clockinproof.com/?tenant=\${t.slug}" target="_blank" class="btn btn-ghost" title="Open Admin Panel" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i></a>
          \${t.status==='active'
            ? '<button class="btn btn-warning" onclick="event.stopPropagation();suspendTenant('+t.id+')" title="Suspend"><i class="fas fa-pause"></i></button>'
            : '<button class="btn btn-success" onclick="event.stopPropagation();activateTenant('+t.id+')" title="Activate"><i class="fas fa-play"></i></button>'
          }
          \${t.id !== 1 ? '<button class="btn btn-danger" data-id="'+t.id+'" data-name="'+encodeURIComponent(t.company_name||'')+'" onclick="event.stopPropagation();deleteTenantBtn(this)" title="Delete / Archive"><i class="fas fa-trash"></i></button>' : ''}
        </div>
      </td>
    </tr>\`
  }).join('')
}

// ── Archive Tab ─────────────────────────────────────────────────────────────
let _currentTenantTab = 'active'
function switchTenantTab(tab) {
  _currentTenantTab = tab
  const activeBtn   = document.getElementById('tab-active-tenants')
  const archiveBtn  = document.getElementById('tab-archived-tenants')
  const activePanel  = document.getElementById('active-tenants-panel')
  const archivePanel = document.getElementById('archived-tenants-panel')
  if (tab === 'active') {
    activeBtn.style.borderBottomColor  = '#818cf8'
    activeBtn.style.color              = '#fff'
    archiveBtn.style.borderBottomColor = 'transparent'
    archiveBtn.style.color             = '#64748b'
    activePanel.style.display  = 'block'
    archivePanel.style.display = 'none'
  } else {
    archiveBtn.style.borderBottomColor = '#f59e0b'
    archiveBtn.style.color             = '#fbbf24'
    activeBtn.style.borderBottomColor  = 'transparent'
    activeBtn.style.color              = '#64748b'
    activePanel.style.display  = 'none'
    archivePanel.style.display = 'block'
    loadArchivedTenants()
  }
}

async function loadArchivedTenants() {
  const tbody = document.getElementById('archived-tbody')
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  try {
    const d = await api('/api/super/tenants/archived')
    const tenants = d.tenants || []
    // Update badge
    const badge = document.getElementById('archived-count-badge')
    if (tenants.length > 0) {
      badge.textContent = tenants.length
      badge.style.display = 'inline'
    } else {
      badge.style.display = 'none'
    }
    if (!tenants.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-check-circle" style="color:#22c55e;margin-right:8px"></i>No archived companies</td></tr>'
      return
    }
    tbody.innerHTML = tenants.map(t => {
      const archivedOn = t.archived_at ? new Date(t.archived_at).toLocaleDateString() : (t.updated_at ? new Date(t.updated_at).toLocaleDateString() : '—')
      const daysLeft = typeof t.days_until_purge === 'number' ? t.days_until_purge : 90
      const purgeColor = daysLeft <= 7 ? '#ef4444' : daysLeft <= 30 ? '#f59e0b' : '#94a3b8'
      const purgeLabel = daysLeft <= 0 ? '<span style="color:#ef4444;font-weight:700">⚠ Purge due</span>' : \`<span style="color:\${purgeColor};font-weight:600">\${daysLeft}d left</span>\`
      return \`<tr>
        <td>
          <div style="font-weight:600;color:#e2e8f0">\${t.company_name}</div>
          <div style="font-size:10px;color:#475569;margin-top:2px">ID \${t.id}</div>
        </td>
        <td><span style="color:#64748b;font-size:12px">\${t.slug}</span></td>
        <td style="color:#64748b;font-size:12px">\${t.admin_email || '—'}</td>
        <td style="color:#64748b;text-align:center">\${t.worker_count || 0}</td>
        <td style="color:#64748b;text-align:center">\${t.session_count || 0}</td>
        <td style="color:#64748b;font-size:12px">\${archivedOn}</td>
        <td>\${purgeLabel}</td>
        <td style="text-align:right">
          <button class="btn btn-success" onclick="restoreTenant(\${t.id}, '\${encodeURIComponent(t.company_name||'')}')" title="Restore company">
            <i class="fas fa-undo"></i> Restore
          </button>
        </td>
      </tr>\`
    }).join('')
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#ef4444">Failed to load archived companies</td></tr>'
  }
}

async function restoreTenant(id, encodedName) {
  const name = decodeURIComponent(encodedName)
  if (!confirm('Restore "' + name + '" back to active status?')) return
  try {
    const r = await fetch('/api/super/tenants/' + id + '/restore', {
      method: 'POST',
      headers: { 'X-Super-Token': superToken }
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || d.error) throw new Error(d.error || 'Server error (' + r.status + ')')
    showToast('✅ ' + name + ' restored to active')
    loadArchivedTenants()
    // Refresh badge
    api('/api/super/tenants/archived').then(data => {
      const badge = document.getElementById('archived-count-badge')
      const count = (data.tenants || []).length
      badge.textContent = count; badge.style.display = count > 0 ? 'inline' : 'none'
    }).catch(() => {})
  } catch(e) {
    showToast('❌ Restore failed: ' + (e.message || 'Unknown error'), true)
  }
}

// ── Edit Modal ──────────────────────────────────────────────────────────────
function openEditModal(t) {
  if (typeof t === 'string') t = JSON.parse(t)
  document.getElementById('edit-tenant-id').value = t.id
  document.getElementById('edit-company').value  = t.company_name||''
  document.getElementById('edit-email').value    = t.admin_email||''
  document.getElementById('edit-pin').value      = t.admin_pin||''
  document.getElementById('edit-status').value   = t.status||'active'
  document.getElementById('edit-max-workers').value = t.max_workers||''
  document.getElementById('edit-color').value    = t.primary_color||'#4F46E5'
  document.getElementById('edit-address').value  = t.company_address||''
  // populate plan dropdown then set value
  if (_plansData.length) {
    populatePlanDropdowns(_plansData, (t.plan||'starter').toLowerCase())
  } else {
    api('/api/super/plans').then(d => {
      _plansData = d.plans || []
      populatePlanDropdowns(_plansData, (t.plan||'starter').toLowerCase())
    }).catch(()=>{})
  }
  document.getElementById('edit-modal').classList.add('open')
}
function closeEditModal() { document.getElementById('edit-modal').classList.remove('open') }

async function saveTenant() {
  const id = document.getElementById('edit-tenant-id').value
  const body = {
    company_name: document.getElementById('edit-company').value,
    admin_email:  document.getElementById('edit-email').value,
    admin_pin:    document.getElementById('edit-pin').value,
    plan:         document.getElementById('edit-plan').value,
    status:       document.getElementById('edit-status').value,
    max_workers:  parseInt(document.getElementById('edit-max-workers').value)||undefined,
    primary_color:document.getElementById('edit-color').value,
    company_address:document.getElementById('edit-address').value
  }
  try {
    await api('/api/super/tenants/'+id, { method:'PUT', body:JSON.stringify(body) })
    closeEditModal(); showToast('✅ Tenant updated'); loadTenants()
  } catch { showToast('❌ Update failed', true) }
}

async function suspendTenant(id) {
  if (!confirm('Suspend this tenant? Workers will not be able to clock in.')) return
  await api('/api/super/tenants/'+id, { method:'PUT', body:JSON.stringify({status:'suspended'}) })
  showToast('⏸ Tenant suspended'); loadTenants()
}
async function activateTenant(id) {
  await api('/api/super/tenants/'+id, { method:'PUT', body:JSON.stringify({status:'active'}) })
  showToast('▶ Tenant activated'); loadTenants()
}
function deleteTenantBtn(btn) {
  const id   = btn.getAttribute('data-id')
  const name = decodeURIComponent(btn.getAttribute('data-name')||'')
  openDeleteModal(id, name)
}

// Delete confirmation modal state
let _deleteId = null, _deleteName = ''
function openDeleteModal(id, name) {
  _deleteId = id; _deleteName = name
  document.getElementById('delete-modal-desc').textContent = 'You are about to archive "' + name + '". Their workers will immediately lose access.'
  document.getElementById('delete-name-hint').textContent = 'Expected: ' + name
  document.getElementById('delete-confirm-input').value = ''
  document.getElementById('delete-confirm-btn').style.opacity = '.4'
  document.getElementById('delete-confirm-btn').style.pointerEvents = 'none'
  document.getElementById('delete-result').style.display = 'none'
  document.getElementById('delete-modal').classList.add('open')
}
function closeDeleteModal() {
  document.getElementById('delete-modal').classList.remove('open')
  _deleteId = null; _deleteName = ''
}
function checkDeleteConfirm() {
  const val = document.getElementById('delete-confirm-input').value.trim()
  const btn = document.getElementById('delete-confirm-btn')
  if (val === _deleteName) {
    btn.style.opacity = '1'; btn.style.pointerEvents = 'auto'
  } else {
    btn.style.opacity = '.4'; btn.style.pointerEvents = 'none'
  }
}
async function executeDeleteTenant() {
  if (!_deleteId) return
  const btn = document.getElementById('delete-confirm-btn')
  const resultEl = document.getElementById('delete-result')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px"></i>Archiving…'
  resultEl.style.display = 'none'
  try {
    const r = await fetch('/api/super/tenants/' + _deleteId, {
      method: 'DELETE',
      headers: { 'X-Super-Token': superToken }
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || d.error) throw new Error(d.error || 'Server error ('+r.status+')')
    resultEl.style.display = 'block'
    resultEl.style.background = '#052e16'
    resultEl.style.border = '1px solid #16a34a'
    resultEl.style.color = '#86efac'
    resultEl.innerHTML = '<i class="fas fa-check-circle" style="margin-right:6px"></i><strong>' + _deleteName + '</strong> has been archived successfully. Workers can no longer clock in.'
    btn.style.display = 'none'
    showToast('🗑 ' + _deleteName + ' archived')
    setTimeout(() => { closeDeleteModal(); loadTenants(); switchTenantTab('archived') }, 2500)
  } catch(e) {
    resultEl.style.display = 'block'
    resultEl.style.background = '#450a0a'
    resultEl.style.border = '1px solid #dc2626'
    resultEl.style.color = '#fca5a5'
    resultEl.innerHTML = '<i class="fas fa-exclamation-circle" style="margin-right:6px"></i>Failed to archive: ' + (e.message || 'Unknown error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-trash" style="margin-right:6px"></i>Try Again'
  }
}

// ── Create Tenant ───────────────────────────────────────────────────────────
let slugCheckTimer = null
function onSlugInput() {
  const slug = document.getElementById('new-slug').value.trim()
  const emailEl = document.getElementById('new-email-slug')
  if (!emailEl._manuallyEdited) { emailEl.value = slug; updateEmailPreview(slug) }
  checkSlug(slug)
}
function onEmailSlugInput() {
  const el = document.getElementById('new-email-slug')
  el._manuallyEdited = true
  updateEmailPreview(el.value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-'))
}
function updateEmailPreview(val) {
  const p = document.getElementById('email-preview')
  if (val) { p.textContent = '→ admin.'+val+'@clockinproof.com'; p.style.display='block' }
  else p.style.display='none'
}
document.getElementById('new-company').addEventListener('input', function() {
  const slugEl = document.getElementById('new-slug')
  const emailEl = document.getElementById('new-email-slug')
  if (!slugEl.value) {
    const auto = this.value.toLowerCase().replace(/[^a-z0-9\\s-]/g,'').trim().replace(/\\s+/g,'-').replace(/-+/g,'-')
    slugEl.value = auto
    if (!emailEl._manuallyEdited) { emailEl.value = auto; updateEmailPreview(auto) }
    checkSlug(auto)
  }
})
async function checkSlug(val) {
  clearTimeout(slugCheckTimer)
  const el = document.getElementById('slug-check')
  if (!val) { el.textContent=''; return }
  el.textContent = '⏳'
  slugCheckTimer = setTimeout(async () => {
    try {
      const d = await fetch('/api/tenants/check-slug?slug='+encodeURIComponent(val)).then(r=>r.json())
      el.textContent = d.available ? '✅' : '❌'
    } catch { el.textContent='?' }
  }, 500)
}
async function createTenant() {
  const company  = document.getElementById('new-company').value.trim()
  const slug     = document.getElementById('new-slug').value.trim()
  const eSlug    = (document.getElementById('new-email-slug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-'))||slug
  const email    = 'admin.'+eSlug+'@clockinproof.com'
  const pin      = document.getElementById('new-pin').value.trim()
  const plan     = document.getElementById('new-plan').value
  const address  = document.getElementById('new-address').value.trim()
  if (!company || !slug) { showToast('❌ Company name and subdomain required', true); return }
  const res = document.getElementById('create-result')
  res.style.cssText = 'display:block;padding:12px;border-radius:8px;background:#1e293b;color:#94a3b8;font-size:13px'
  res.textContent = 'Creating tenant...'
  try {
    const d = await api('/api/super/tenants', {
      method: 'POST',
      body: JSON.stringify({ slug, company_name:company, admin_email:email, admin_pin:pin||'1234', plan, company_address:address })
    })
    if (d.error) {
      res.style.cssText = 'display:block;padding:12px;border-radius:8px;background:#7f1d1d33;border:1px solid #dc2626;color:#fca5a5;font-size:13px'
      res.textContent = '❌ '+d.error; return
    }
    res.style.cssText = 'display:block;padding:12px;border-radius:8px;background:#065f4633;border:1px solid #059669;color:#6ee7b7;font-size:13px'
    res.innerHTML = \`✅ <strong>Tenant created!</strong><br>
      Admin email: <strong>\${email}</strong><br>
      Worker app: <a href="https://\${d.slug}.clockinproof.com" target="_blank" style="color:#6ee7b7;text-decoration:underline">\${d.slug}.clockinproof.com</a>\`
    ;['new-company','new-slug','new-email-slug','new-pin','new-address'].forEach(id => {
      const el = document.getElementById(id); if(el){el.value='';el._manuallyEdited=false}
    })
    document.getElementById('new-plan').value = 'growth'
    document.getElementById('slug-check').textContent = ''
    document.getElementById('email-preview').style.display = 'none'
    showToast('🎉 Tenant created!')
    allTenants = []
  } catch { 
    res.style.cssText = 'display:block;padding:12px;border-radius:8px;background:#7f1d1d33;border:1px solid #dc2626;color:#fca5a5;font-size:13px'
    res.textContent = '❌ Failed to create tenant'
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────
async function loadSessions() {
  const tbody = document.getElementById('sessions-tbody')
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  const tid = document.getElementById('sess-tenant-filter').value
  try {
    const params = new URLSearchParams({ page: sessPage, limit: sessLimit })
    if (tid) params.set('tenant_id', tid)
    const d = await api('/api/super/sessions?' + params)
    const rows = d.sessions || []
    document.getElementById('sess-info').textContent = 'Showing ' + ((sessPage-1)*sessLimit+1) + '–' + Math.min(sessPage*sessLimit, d.total) + ' of ' + d.total
    document.getElementById('sess-prev').disabled = sessPage <= 1
    document.getElementById('sess-next').disabled = sessPage * sessLimit >= d.total
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#475569">No sessions found</td></tr>'
      return
    }
    tbody.innerHTML = rows.map(s => {
      const cin = s.clock_in_time ? new Date(s.clock_in_time).toLocaleString() : '—'
      const cout = s.clock_out_time ? new Date(s.clock_out_time).toLocaleString() : '<span class="live-dot" style="margin-right:4px"></span>Active'
      const sc = s.status==='completed' ? 'badge-active' : 'badge-trial'
      return \`<tr>
        <td style="font-weight:600;color:#e2e8f0">\${s.worker_name||'—'}</td>
        <td style="color:#818cf8;font-size:12px">\${s.company_name||'—'}</td>
        <td style="color:#94a3b8;font-size:12px">\${cin}</td>
        <td style="color:#94a3b8;font-size:12px">\${cout}</td>
        <td style="color:#34d399;font-weight:600">\${s.total_hours?s.total_hours.toFixed(1)+'h':'—'}</td>
        <td style="color:#64748b;font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${s.job_location||s.clock_in_address||'—'}</td>
        <td><span class="pill \${sc}">\${s.status||'—'}</span></td>
      </tr>\`
    }).join('')
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#ef4444">Failed to load sessions</td></tr>'
  }
}
function changeSessPage(dir) { sessPage = Math.max(1, sessPage+dir); loadSessions() }

// ── Revenue ─────────────────────────────────────────────────────────────────
async function loadRevenue() {
  const tbody = document.getElementById('revenue-tbody')
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  try {
    const d = await api('/api/super/revenue')
    const rows = d.tenants || []
    document.getElementById('rev-mrr').textContent = (d.total_mrr||0).toLocaleString()
    document.getElementById('rev-tenants').textContent = rows.length
    document.getElementById('rev-arr').textContent = ((d.total_mrr||0)*12).toLocaleString()
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#475569">No revenue data</td></tr>'
      return
    }
    tbody.innerHTML = rows.map(r => {
      const pc = r.plan==='pro'?'badge-pro':r.plan==='growth'?'badge-growth':'badge-starter'
      const sc = r.status==='active'?'badge-active':r.status==='trial'?'badge-trial':'badge-suspended'
      return \`<tr>
        <td><div style="font-weight:600;color:#e2e8f0">\${r.company_name}</div><div style="color:#475569;font-size:11px">\${r.slug}</div></td>
        <td><span class="pill \${pc}">\${r.plan||'—'}</span></td>
        <td><span class="pill \${sc}">\${r.status||'—'}</span></td>
        <td style="color:#94a3b8">\${r.workers||0}</td>
        <td style="color:#94a3b8">\${r.sessions||0}</td>
        <td style="color:#94a3b8">\${r.total_hours||0}h</td>
        <td style="font-weight:700;color:#34d399">$\${r.mrr||0}/mo</td>
      </tr>\`
    }).join('')
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:#ef4444">Failed to load revenue</td></tr>'
  }
}

// ── Email test ───────────────────────────────────────────────────────────────
async function sendTestEmail() {
  const to = document.getElementById('test-email-to').value.trim()
  if (!to) { showToast('❌ Enter a recipient email', true); return }
  const res = document.getElementById('test-email-result')
  res.textContent = 'Sending...'; res.style.display='block'; res.style.color='#94a3b8'
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + (window._rk||'') },
      body: JSON.stringify({
        from:'ClockInProof <alerts@clockinproof.com>',
        to:[to],
        subject:'✅ ClockInProof — Super Admin Test Email',
        html:'<div style="font-family:sans-serif;padding:24px"><h2>Test Email</h2><p>Sent from the Super Admin portal.</p></div>'
      })
    })
    // Use backend proxy instead
    const d = await api('/api/super/test-email', { method:'POST', body:JSON.stringify({to}) })
    if (d.error) { res.textContent='❌ '+d.error; res.style.color='#fca5a5'; return }
    res.textContent = '✅ Email sent! ID: '+d.id; res.style.color='#6ee7b7'
    showToast('✅ Test email sent!')
  } catch(e) {
    res.textContent = '❌ Failed — check browser console'; res.style.color='#fca5a5'
  }
}

// ── Platform: change super PIN ───────────────────────────────────────────────
async function changeSuperPin() {
  const newPin = document.getElementById('new-super-pin').value.trim()
  if (!newPin || newPin.length < 6) { showToast('❌ PIN must be at least 6 characters', true); return }
  showToast('ℹ️ To change the PIN, update SUPER_ADMIN_PIN secret in Cloudflare Pages dashboard', false)
  document.getElementById('new-super-pin').value = ''
}

// ── Platform URL Config ───────────────────────────────────────────────────────
async function loadPlatformUrls() {
  try {
    const d = await api('/api/settings')
    const s = d.settings || {}
    const appEl   = document.getElementById('sp-app-host')
    const adminEl = document.getElementById('sp-admin-host')
    if (appEl)   appEl.value   = s.app_host   || ''
    if (adminEl) adminEl.value = s.admin_host  || ''
    // Load Twilio DB values (Cloudflare secrets take priority at runtime)
    const sidEl    = document.getElementById('sp-twilio-sid')
    const tokenEl  = document.getElementById('sp-twilio-token')
    const fromEl   = document.getElementById('sp-twilio-from')
    const msgsvcEl = document.getElementById('sp-twilio-msgsvc')
    if (sidEl)    sidEl.value    = s.twilio_account_sid       || ''
    if (tokenEl)  tokenEl.value  = s.twilio_auth_token        || ''
    if (fromEl)   fromEl.value   = s.twilio_from_number       || ''
    if (msgsvcEl) msgsvcEl.value = s.twilio_messaging_service || ''
    // Load Resend DB values
    const resendKeyEl  = document.getElementById('sp-resend-key')
    const resendFromEl = document.getElementById('sp-resend-from')
    if (resendKeyEl)  resendKeyEl.value  = s.resend_api_key  || ''
    if (resendFromEl) resendFromEl.value = s.resend_from     || ''
  } catch(e) { showToast('Failed to load platform settings', true) }
}

async function savePlatformUrls() {
  const appHost   = (document.getElementById('sp-app-host')?.value   || '').trim()
  const adminHost = (document.getElementById('sp-admin-host')?.value || '').trim()
  const statusEl  = document.getElementById('sp-url-status')
  try {
    const d = await api('/api/settings')
    const current = d.settings || {}
    const payload = { ...current, app_host: appHost, admin_host: adminHost }
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('Save failed')
    if (statusEl) { statusEl.textContent = '✓ URLs saved successfully'; statusEl.style.display = 'block' }
    showToast('✅ Platform URLs saved')
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none' }, 4000)
  } catch(e) { showToast('❌ Failed to save URLs', true) }
}

async function savePlatformTwilio() {
  const sid    = (document.getElementById('sp-twilio-sid')?.value    || '').trim()
  const token  = (document.getElementById('sp-twilio-token')?.value  || '').trim()
  const from   = (document.getElementById('sp-twilio-from')?.value   || '').trim()
  const msgsvc = (document.getElementById('sp-twilio-msgsvc')?.value || '').trim()
  const statusEl = document.getElementById('sp-twilio-status')
  try {
    const d = await api('/api/settings')
    const current = d.settings || {}
    const payload = { ...current,
      twilio_account_sid: sid,
      twilio_auth_token: token,
      twilio_from_number: from,
      twilio_messaging_service: msgsvc
    }
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('Save failed')
    if (statusEl) { statusEl.textContent = '✓ Twilio credentials saved to DB (Cloudflare secrets override these at runtime)'; statusEl.style.display = 'block' }
    showToast('✅ Twilio credentials saved')
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none' }, 5000)
  } catch(e) { showToast('❌ Failed to save Twilio credentials', true) }
}

async function savePlatformResend() {
  const key  = (document.getElementById('sp-resend-key')?.value  || '').trim()
  const from = (document.getElementById('sp-resend-from')?.value || '').trim()
  const statusEl = document.getElementById('sp-resend-status')
  try {
    const d = await api('/api/settings')
    const current = d.settings || {}
    const payload = { ...current, resend_api_key: key, resend_from: from }
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('Save failed')
    if (statusEl) { statusEl.textContent = '✓ Resend config saved (RESEND_API_KEY secret overrides at runtime)'; statusEl.style.display = 'block' }
    showToast('✅ Resend config saved')
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none' }, 5000)
  } catch(e) { showToast('❌ Failed to save Resend config', true) }
}

async function testPlatformSms() {
  const adminPhone = prompt('Send test SMS to which number? (include + country code)')
  if (!adminPhone) return
  showToast('📤 Sending test SMS...')
  try {
    const res = await fetch('/api/test/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: adminPhone, message: '✅ ClockInProof platform SMS test — it works!' })
    })
    const d = await res.json()
    if (d.success) showToast('✅ Test SMS sent to ' + adminPhone)
    else showToast('❌ ' + (d.error || 'SMS failed'), true)
  } catch(e) { showToast('❌ Test SMS failed', true) }
}

async function testPlatformEmail() {
  const toEmail = prompt('Send test email to which address?')
  if (!toEmail) return
  showToast('📤 Sending test email...')
  try {
    const res = await fetch('/api/test/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: toEmail })
    })
    const d = await res.json()
    if (d.success) showToast('✅ Test email sent to ' + toEmail)
    else showToast('❌ ' + (d.error || 'Email failed'), true)
  } catch(e) { showToast('❌ Test email failed', true) }
}

// ── Support Tickets ───────────────────────────────────────────────────────────
let allTickets = []
let currentTicketId = null

async function loadTickets() {
  const tbody = document.getElementById('tickets-tbody')
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#475569"><i class="fas fa-spinner fa-spin"></i></td></tr>'
  const statusFilter = document.getElementById('tkt-filter-status').value
  try {
    const d = await api('/api/super/tickets' + (statusFilter ? '?status=' + statusFilter : ''))
    allTickets = d.tickets || []
    const cnt = d.counts || {}
    document.getElementById('tkst-open').textContent     = cnt.open_count || 0
    document.getElementById('tkst-progress').textContent = cnt.in_progress_count || 0
    document.getElementById('tkst-resolved').textContent = cnt.resolved_count || 0
    document.getElementById('tkst-urgent').textContent   = cnt.urgent_open || 0
    const openCount = (cnt.open_count||0) + (cnt.in_progress_count||0)
    const badge = document.getElementById('support-badge')
    badge.textContent = openCount
    badge.style.display = openCount > 0 ? 'inline' : 'none'
    renderTickets(allTickets)
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:#ef4444">Failed to load tickets</td></tr>'
  }
}

function filterTickets() {
  const q  = document.getElementById('tkt-search').value.toLowerCase()
  const fp = document.getElementById('tkt-filter-priority').value
  renderTickets(allTickets.filter(t =>
    (!q  || t.subject.toLowerCase().includes(q) || t.ticket_number.toLowerCase().includes(q) || (t.company_name||'').toLowerCase().includes(q)) &&
    (!fp || t.priority === fp)
  ))
}

const PRIORITY_STYLES = {
  urgent: { bg:'#7f1d1d', color:'#fca5a5', label:'URGENT' },
  high:   { bg:'#78350f', color:'#fcd34d', label:'HIGH' },
  normal: { bg:'#1e3a5f', color:'#93c5fd', label:'NORMAL' },
  low:    { bg:'#1e293b', color:'#64748b', label:'LOW' }
}
const STATUS_STYLES = {
  open:        { bg:'#78350f', color:'#fcd34d', label:'OPEN' },
  in_progress: { bg:'#312e81', color:'#a5b4fc', label:'IN PROGRESS' },
  resolved:    { bg:'#065f46', color:'#6ee7b7', label:'RESOLVED' },
  closed:      { bg:'#1e293b', color:'#64748b', label:'CLOSED' }
}

function renderTickets(tickets) {
  const tbody = document.getElementById('tickets-tbody')
  if (!tickets.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:48px;color:#475569"><i class="fas fa-ticket" style="font-size:28px;display:block;margin-bottom:10px"></i>No tickets found</td></tr>'
    return
  }
  tbody.innerHTML = tickets.map(t => {
    const ps = PRIORITY_STYLES[t.priority] || PRIORITY_STYLES.normal
    const ss = STATUS_STYLES[t.status]     || STATUS_STYLES.open
    const updated = t.updated_at ? new Date(t.updated_at).toLocaleDateString() : '—'
    return \`<tr style="cursor:pointer" onclick="openTicket(\${t.id})">
      <td style="font-family:monospace;font-size:12px;color:#818cf8">\${t.ticket_number}</td>
      <td><div style="font-weight:600;color:#e2e8f0;font-size:13px">\${t.subject}</div>
          <div style="color:#475569;font-size:11px">\${t.category||'general'}</div></td>
      <td style="color:#94a3b8;font-size:12px">\${t.company_name||'—'}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:\${ps.bg};color:\${ps.color}">\${ps.label}</span></td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:\${ss.bg};color:\${ss.color}">\${ss.label}</span></td>
      <td style="color:#64748b;font-size:12px">\${t.message_count||0}</td>
      <td style="color:#64748b;font-size:12px">\${updated}</td>
      <td style="text-align:right"><button class="btn btn-ghost" onclick="event.stopPropagation();openTicket(\${t.id})" style="font-size:11px"><i class="fas fa-eye"></i> Open</button></td>
    </tr>\`
  }).join('')
}

async function openTicket(id) {
  currentTicketId = id
  document.getElementById('tkt-thread').innerHTML = '<div style="text-align:center;color:#475569;padding:30px"><i class="fas fa-spinner fa-spin"></i></div>'
  document.getElementById('ticket-modal').classList.add('open')
  try {
    const d = await api('/api/super/tickets/' + id)
    const t = d.ticket
    document.getElementById('tkt-modal-number').textContent  = t.ticket_number
    document.getElementById('tkt-modal-subject').textContent = t.subject
    document.getElementById('tkt-modal-meta').textContent    =
      (t.company_name||'') + ' · ' + (t.submitter_email||'') + ' · ' + new Date(t.created_at).toLocaleString()
    const ss = STATUS_STYLES[t.status]     || STATUS_STYLES.open
    const ps = PRIORITY_STYLES[t.priority] || PRIORITY_STYLES.normal
    document.getElementById('tkt-modal-status-badge').innerHTML =
      \`<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;background:\${ss.bg};color:\${ss.color}">\${ss.label}</span>\`
    document.getElementById('tkt-modal-priority-badge').innerHTML =
      \`<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;background:\${ps.bg};color:\${ps.color}">\${ps.label}</span>\`
    document.getElementById('tkt-status-select').value   = t.status
    document.getElementById('tkt-priority-select').value = t.priority
    const msgs = d.messages || []
    document.getElementById('tkt-thread').innerHTML = msgs.length ? msgs.map(m => {
      const isTenant   = m.sender_type === 'tenant'
      const isSystem   = m.sender_type === 'system'
      const isInternal = m.is_internal
      let bg = isTenant ? '#0f172a' : (isSystem ? '#1a2234' : '#1e1b40')
      let borderLeft = isTenant ? '#334155' : (isSystem ? '#334155' : '#4f46e5')
      if (isInternal) { bg = '#1a1200'; borderLeft = '#d97706' }
      return \`<div style="background:\${bg};border:1px solid #334155;border-left:3px solid \${borderLeft};border-radius:8px;padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:700;font-size:13px;color:\${isTenant?'#93c5fd':isSystem?'#64748b':'#a5b4fc'}">\${m.sender_name}</span>
            \${isTenant   ? '<span style="background:#1e3a5f;color:#93c5fd;font-size:10px;padding:1px 7px;border-radius:20px;font-weight:700">TENANT</span>' : ''}
            \${isInternal ? '<span style="background:#1a1200;color:#d97706;font-size:10px;padding:1px 7px;border-radius:20px;border:1px solid #d97706;font-weight:700">INTERNAL NOTE</span>' : ''}
            \${isSystem   ? '<span style="background:#1e293b;color:#475569;font-size:10px;padding:1px 7px;border-radius:20px;font-weight:700">SYSTEM</span>' : ''}
          </div>
          <span style="font-size:11px;color:#475569">\${new Date(m.created_at).toLocaleString()}</span>
        </div>
        <p style="color:#e2e8f0;font-size:13px;line-height:1.6;white-space:pre-wrap;margin:0">\${m.message}</p>
      </div>\`
    }).join('') : '<p style="text-align:center;color:#475569;padding:20px">No messages yet</p>'
    const thread = document.getElementById('tkt-thread')
    setTimeout(() => { thread.scrollTop = thread.scrollHeight }, 50)
  } catch(e) {
    document.getElementById('tkt-thread').innerHTML = '<p style="color:#ef4444;text-align:center;padding:20px">Failed to load ticket</p>'
  }
}

function closeTicketModal() {
  document.getElementById('ticket-modal').classList.remove('open')
  document.getElementById('tkt-reply-text').value = ''
  document.getElementById('tkt-internal-note').checked = false
  currentTicketId = null
}

async function sendTicketReply() {
  if (!currentTicketId) return
  const message    = document.getElementById('tkt-reply-text').value.trim()
  const isInternal = document.getElementById('tkt-internal-note').checked
  if (!message) { showToast('❌ Type a reply first', true); return }
  try {
    await api('/api/super/tickets/' + currentTicketId + '/reply', {
      method: 'POST', body: JSON.stringify({ message, is_internal: isInternal })
    })
    document.getElementById('tkt-reply-text').value = ''
    document.getElementById('tkt-internal-note').checked = false
    showToast(isInternal ? '📝 Internal note added' : '✅ Reply sent to tenant')
    await openTicket(currentTicketId)
    loadTickets()
  } catch { showToast('❌ Failed to send reply', true) }
}

async function updateTicketStatus() {
  if (!currentTicketId) return
  const status   = document.getElementById('tkt-status-select').value
  const priority = document.getElementById('tkt-priority-select').value
  try {
    await Promise.all([
      api('/api/super/tickets/' + currentTicketId + '/status',   { method:'PUT', body:JSON.stringify({ status }) }),
      api('/api/super/tickets/' + currentTicketId + '/priority', { method:'PUT', body:JSON.stringify({ priority }) })
    ])
    showToast('✅ Ticket updated')
    await openTicket(currentTicketId)
    loadTickets()
  } catch { showToast('❌ Update failed', true) }
}

async function resolveAndClose() {
  if (!currentTicketId) return
  if (!confirm('Mark this ticket as Resolved and close it? The tenant will receive an email confirmation.')) return
  const note = prompt('Optional resolution note for the tenant (leave blank to skip):')
  try {
    await api('/api/super/tickets/' + currentTicketId + '/status', {
      method: 'PUT', body: JSON.stringify({ status: 'closed', resolution_note: note || '' })
    })
    showToast('🔒 Ticket closed — tenant notified by email')
    closeTicketModal()
    loadTickets()
  } catch { showToast('❌ Failed to close ticket', true) }
}

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, isError=false) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.style.borderColor = isError ? '#dc2626' : '#4f46e5'
  t.style.display = 'block'
  setTimeout(()=>{ t.style.display='none' }, 3500)
}

// ── Tenant Profile Drawer ────────────────────────────────────────────────────
let _profileTenantId = null

function openTenantProfile(id) {
  _profileTenantId = id
  const overlay = document.getElementById('tenant-profile-overlay')
  const drawer  = document.getElementById('tenant-profile-drawer')
  overlay.style.display = 'block'
  drawer.style.display  = 'block'
  document.getElementById('tp-body').innerHTML = '<div style="text-align:center;padding:60px;color:#475569"><i class="fas fa-spinner fa-spin"></i> Loading tenant profile...</div>'
  // Reset header
  document.getElementById('tp-name').textContent  = 'Loading...'
  document.getElementById('tp-meta').textContent  = '—'
  document.getElementById('tp-status-badge').textContent = '—'
  document.getElementById('tp-plan-badge').textContent   = '—'
  loadTenantProfile(id)
}

function closeTenantProfile() {
  document.getElementById('tenant-profile-overlay').style.display = 'none'
  document.getElementById('tenant-profile-drawer').style.display  = 'none'
  _profileTenantId = null
}

// Close on Escape key
document.addEventListener('keydown', e => { if (e.key === 'Escape' && _profileTenantId) closeTenantProfile() })

async function loadTenantProfile(id) {
  try {
    const d = await api('/api/super/tenants/' + id + '/profile')
    const t  = d.tenant
    const st = d.stats || {}

    // ── Header ──
    const logo = document.getElementById('tp-logo')
    logo.textContent       = (t.company_name||'?')[0].toUpperCase()
    logo.style.background  = t.primary_color || '#4f46e5'
    document.getElementById('tp-name').textContent = t.company_name || '—'

    const stBadge = document.getElementById('tp-status-badge')
    stBadge.textContent  = t.status || '—'
    stBadge.className    = 'pill ' + (t.status==='active'?'badge-active':t.status==='trial'?'badge-trial':'badge-suspended')

    const plBadge = document.getElementById('tp-plan-badge')
    plBadge.textContent  = (t.plan||'starter').toUpperCase()
    plBadge.className    = 'pill ' + (t.plan==='pro'?'badge-pro':t.plan==='growth'?'badge-growth':'badge-starter')

    const since = t.days_active != null ? t.days_active + ' days active' : ''
    document.getElementById('tp-meta').textContent = [t.admin_email, since, 'Slug: ' + t.slug].filter(Boolean).join('  ·  ')

    document.getElementById('tp-admin-link').href = t.admin_url || '#'
    document.getElementById('tp-app-link').href   = t.app_url   || '#'

    // ── Body ──
    const nowIn    = st.currently_in  || 0
    const alerts   = (d.pending_device_resets||[]).length + (d.open_tickets||[]).length
    const alertBadge = alerts > 0 ? \`<span style="background:#dc2626;color:#fff;border-radius:20px;padding:2px 8px;font-size:11px;font-weight:700;margin-left:6px">\${alerts} alert\${alerts!==1?'s':''}</span>\` : ''

    document.getElementById('tp-body').innerHTML = \`
    <!-- KPI row -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:20px">
      \${kpiCard('fas fa-users','Workers',\`\${st.total_workers||0} / \${t.max_workers||'∞'}\`,'#6366f1')}
      \${kpiCard('fas fa-clock','Clocked In Now',nowIn,'#22c55e')}
      \${kpiCard('fas fa-history','Total Sessions',st.total_sessions||0,'#818cf8')}
      \${kpiCard('fas fa-hourglass-half','Total Hours',(st.total_hours||0)+'h','#f59e0b')}
      \${kpiCard('fas fa-calendar-alt','Days Active',t.days_active!=null?t.days_active+'d':'—','#06b6d4')}
      \${kpiCard('fas fa-bell','Open Alerts',alerts,alerts>0?'#ef4444':'#64748b')}
    </div>

    <!-- Alerts section -->
    \${(d.pending_device_resets||[]).length > 0 ? \`
    <div style="background:#1c0a0a;border:1px solid #dc2626;border-radius:10px;padding:14px 16px;margin-bottom:16px">
      <div style="color:#fca5a5;font-weight:700;font-size:13px;margin-bottom:8px"><i class="fas fa-mobile-alt"></i> Pending Device Resets</div>
      \${(d.pending_device_resets).map(r => \`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #2d0a0a">
          <div><span style="color:#e2e8f0;font-size:13px">\${r.worker_name}</span> <span style="color:#94a3b8;font-size:11px">\${r.phone}</span></div>
          <span style="color:#64748b;font-size:11px">\${new Date(r.created_at).toLocaleDateString()}</span>
        </div>
      \`).join('')}
    </div>
    \` : ''}

    \${(d.open_tickets||[]).length > 0 ? \`
    <div style="background:#0d1117;border:1px solid #f59e0b;border-radius:10px;padding:14px 16px;margin-bottom:16px">
      <div style="color:#fcd34d;font-weight:700;font-size:13px;margin-bottom:8px"><i class="fas fa-ticket-alt"></i> Open Support Tickets</div>
      \${(d.open_tickets).map(tk => \`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #1a1a0d">
          <div style="color:#e2e8f0;font-size:13px">\${tk.subject||'No subject'}</div>
          <span style="background:#374151;color:#fcd34d;border-radius:20px;padding:2px 8px;font-size:10px">\${tk.priority||'normal'}</span>
        </div>
      \`).join('')}
    </div>
    \` : ''}

    <!-- Worker roster -->
    <div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
        <i class="fas fa-id-badge"></i> Worker Roster
        <span style="color:#475569;font-weight:400;text-transform:none;font-size:12px;margin-left:6px">
          \${st.active_workers||0} active · \${st.on_holiday||0} holiday · \${st.sick_leave||0} sick · \${st.suspended||0} suspended
        </span>
      </div>
      \${(d.workers||[]).length === 0
        ? '<div style="color:#475569;font-size:13px;padding:12px 0">No workers yet</div>'
        : \`<div style="background:#0f1a2e;border:1px solid #1e293b;border-radius:10px;overflow:hidden">
          \${(d.workers).map(w => {
            const sc2 = w.status==='active'?'#22c55e':w.status==='on_holiday'?'#f59e0b':w.status==='sick_leave'?'#f97316':'#ef4444'
            const last = w.last_session ? new Date(w.last_session).toLocaleDateString() : 'Never'
            return \`<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #1e293b">
              <span style="width:8px;height:8px;border-radius:50%;background:\${sc2};flex-shrink:0"></span>
              <div style="flex:1;min-width:0">
                <div style="color:#e2e8f0;font-size:13px;font-weight:600">\${w.name}</div>
                <div style="color:#64748b;font-size:11px">\${w.phone} · \${w.session_count||0} sessions · Last: \${last}</div>
              </div>
              <span style="font-size:11px;color:#475569">\${w.status}</span>
              \${w.device_id ? '' : '<span style="font-size:10px;color:#f59e0b;background:#1c1400;border:1px solid #f59e0b;border-radius:4px;padding:1px 5px">no device</span>'}
            </div>\`
          }).join('')}
        </div>\`
      }
    </div>

    <!-- Recent sessions -->
    <div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px"><i class="fas fa-list-alt"></i> Recent Sessions (last 10)</div>
      \${(d.recent_sessions||[]).length === 0
        ? '<div style="color:#475569;font-size:13px;padding:12px 0">No sessions yet</div>'
        : \`<div style="background:#0f1a2e;border:1px solid #1e293b;border-radius:10px;overflow:hidden">
          \${(d.recent_sessions).map(s => {
            const ci   = s.clock_in  ? new Date(s.clock_in).toLocaleString()  : '—'
            const co   = s.clock_out ? new Date(s.clock_out).toLocaleString() : '<span style="color:#22c55e">Active</span>'
            const hrs  = s.total_hours ? s.total_hours.toFixed(1)+'h' : '—'
            return \`<div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #1e293b">
              <div style="flex:1;min-width:0">
                <div style="color:#e2e8f0;font-size:13px;font-weight:600">\${s.worker_name}</div>
                <div style="color:#64748b;font-size:11px">In: \${ci}</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:12px;color:#94a3b8">\${hrs}</div>
                <div style="font-size:10px;color:#475569">Out: \${co}</div>
              </div>
            </div>\`
          }).join('')}
        </div>\`
      }
    </div>

    <!-- Account info -->
    <div style="background:#0f1a2e;border:1px solid #1e293b;border-radius:10px;padding:16px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px"><i class="fas fa-cog"></i> Account Details</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        \${infoRow('Admin Email', t.admin_email||'—')}
        \${infoRow('Admin PIN', t.admin_pin ? '••••' : '—')}
        \${infoRow('Plan', (t.plan||'starter').toUpperCase())}
        \${infoRow('Max Workers', t.max_workers||'∞')}
        \${infoRow('Status', t.status||'—')}
        \${infoRow('Created', t.created_at ? new Date(t.created_at).toLocaleDateString() : '—')}
        \${infoRow('Primary Color', t.primary_color||'—')}
        \${infoRow('Subdomain', t.slug)}
      </div>
    </div>

    <!-- Quick actions -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;padding-bottom:24px">
      <button onclick="closeTenantProfile();openEditModal(\${JSON.stringify(t).replace(/'/g,'&#39;').replace(/\\\\/g,'\\\\\\\\')})" class="btn btn-ghost" style="font-size:12px"><i class="fas fa-edit"></i> Edit Tenant</button>
      \${t.status==='active'
        ? '<button onclick="closeTenantProfile();suspendTenant('+t.id+')" class="btn btn-warning" style="font-size:12px"><i class="fas fa-pause"></i> Suspend Tenant</button>'
        : '<button onclick="closeTenantProfile();activateTenant('+t.id+')" class="btn btn-success" style="font-size:12px"><i class="fas fa-play"></i> Activate Tenant</button>'
      }
    </div>
    \`
  } catch(e) {
    document.getElementById('tp-body').innerHTML = '<div style="color:#ef4444;padding:40px;text-align:center"><i class="fas fa-exclamation-triangle"></i> Failed to load profile: ' + e.message + '</div>'
  }
}

function kpiCard(icon, label, value, color) {
  return \`<div style="background:#0f1a2e;border:1px solid #1e293b;border-radius:10px;padding:14px 16px">
    <div style="color:\${color};font-size:20px;margin-bottom:6px"><i class="\${icon}"></i></div>
    <div style="font-size:20px;font-weight:700;color:#e2e8f0">\${value}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px">\${label}</div>
  </div>\`
}

function infoRow(label, value) {
  return \`<div>
    <div style="font-size:10px;color:#64748b;margin-bottom:2px">\${label}</div>
    <div style="font-size:13px;color:#e2e8f0">\${value}</div>
  </div>\`
}

// ── Plans & Pricing ──────────────────────────────────────────────────────────
let _plansData = []

// Populate any plan <select> elements from DB data
function populatePlanDropdowns(plans, currentVal) {
  const selectors = ['new-plan', 'edit-plan']
  selectors.forEach(id => {
    const sel = document.getElementById(id)
    if (!sel) return
    const prev = currentVal || sel.value
    sel.innerHTML = plans.map(p => {
      const dollars = Math.floor(p.price_monthly / 100)
      const workers = p.max_workers >= 999 ? 'Unlimited workers' : p.max_workers + ' workers'
      const key = (p.name || '').toLowerCase()
      return '<option value="' + key + '">' + p.name + ' — $' + dollars + ' CAD/mo (' + workers + ')</option>'
    }).join('')
    if (prev) sel.value = prev
    if (!sel.value && plans.length) sel.value = (plans[Math.min(1, plans.length-1)].name || '').toLowerCase()
  })
}

async function loadPlansPage() {
  const grid = document.getElementById('plans-grid')
  grid.innerHTML = '<div style="text-align:center;padding:40px;color:#475569;grid-column:1/-1"><i class="fas fa-spinner fa-spin"></i> Loading plans...</div>'
  try {
    const d = await api('/api/super/plans')
    _plansData = d.plans || []
    renderPlansGrid(_plansData)
    populatePlanDropdowns(_plansData, null)  // refresh add/edit dropdowns
  } catch(e) {
    grid.innerHTML = '<div style="color:#ef4444;padding:40px;text-align:center;grid-column:1/-1">Failed to load plans: ' + e.message + '</div>'
  }
}

function renderPlansGrid(plans) {
  const grid = document.getElementById('plans-grid')
  if (!plans.length) {
    grid.innerHTML = '<div style="color:#475569;padding:40px;text-align:center;grid-column:1/-1">No plans found</div>'
    return
  }
  const borderColors = { starter:'#1e3a5f', growth:'#3b1f6b', pro:'#14532d' }
  const textColors   = { starter:'#93c5fd', growth:'#c4b5fd', pro:'#86efac' }
  const pillClass    = { starter:'badge-starter', growth:'badge-growth', pro:'badge-pro' }
  grid.innerHTML = plans.map(p => {
    const key      = (p.name||'').toLowerCase()
    const bc       = borderColors[key] || '#334155'
    const tc       = textColors[key]   || '#e2e8f0'
    const pill     = pillClass[key]    || 'badge-starter'
    const price    = (p.price_monthly / 100).toFixed(0)
    const features = (p.features || '').split(',').filter(Boolean)
    const tenants  = p.tenant_count || 0
    const inactive = !p.active
    return \`<div class="card" style="padding:24px;border-color:\${bc};position:relative;opacity:\${inactive?'0.55':'1'}">
      \${inactive ? '<div style="position:absolute;top:-10px;right:12px;background:#475569;color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:20px">INACTIVE</div>' : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span class="pill \${pill}">\${p.name}</span>
        <span style="font-size:11px;color:#475569">\${tenants} tenant\${tenants!==1?'s':''}</span>
      </div>
      <div style="font-size:34px;font-weight:800;color:\${tc}">$\${price}<span style="font-size:13px;font-weight:400;color:#64748b"> CAD/mo</span></div>
      <div style="font-size:12px;color:#64748b;margin:6px 0 14px">\${p.max_workers >= 999 ? 'Unlimited workers' : 'Up to ' + p.max_workers + ' workers'}</div>
      <ul style="list-style:none;font-size:12px;color:#94a3b8;display:flex;flex-direction:column;gap:5px;margin-bottom:16px;min-height:80px">
        \${features.slice(0,6).map(f => \`<li><i class="fas fa-check" style="color:#22c55e;margin-right:6px"></i>\${f.trim()}</li>\`).join('')}
        \${features.length > 6 ? \`<li style="color:#64748b">+ \${features.length-6} more...</li>\` : ''}
      </ul>
      \${p.stripe_price_id ? \`<div style="font-size:10px;color:#475569;font-family:monospace;margin-bottom:12px;word-break:break-all">\${p.stripe_price_id}</div>\` : '<div style="font-size:10px;color:#ef4444;margin-bottom:12px">⚠ No Stripe Price ID set</div>'}
      <button onclick="openPlanModal(\${p.id})" class="btn btn-ghost" style="width:100%;font-size:12px"><i class="fas fa-edit"></i> Edit Plan</button>
    </div>\`
  }).join('')
}

function openPlanModal(id) {
  const p = _plansData.find(x => x.id === id)
  if (!p) return
  document.getElementById('plan-edit-id').value         = p.id
  document.getElementById('plan-edit-name').value       = p.name || ''
  document.getElementById('plan-edit-price').value      = p.price_monthly || 0
  document.getElementById('plan-edit-workers').value    = p.max_workers || 10
  document.getElementById('plan-edit-stripe-id').value  = p.stripe_price_id || ''
  document.getElementById('plan-edit-features').value   = (p.features || '').split(',').map(f=>f.trim()).join(',' + String.fromCharCode(10))
  document.getElementById('plan-edit-active').checked   = !!p.active
  const msg = document.getElementById('plan-edit-msg')
  msg.style.display = 'none'
  const modal = document.getElementById('plan-edit-modal')
  modal.style.display = 'flex'
}

function closePlanModal() {
  document.getElementById('plan-edit-modal').style.display = 'none'
}

async function savePlanEdit() {
  const id         = document.getElementById('plan-edit-id').value
  const name       = document.getElementById('plan-edit-name').value.trim()
  const price      = parseInt(document.getElementById('plan-edit-price').value)
  const workers    = parseInt(document.getElementById('plan-edit-workers').value)
  const stripeId   = document.getElementById('plan-edit-stripe-id').value.trim()
  const rawFeat    = document.getElementById('plan-edit-features').value
  const features   = rawFeat.replace(/,/g,'|').split('|').map(f=>f.trim()).filter(Boolean).join(',')
  const active     = document.getElementById('plan-edit-active').checked

  const msg = document.getElementById('plan-edit-msg')
  if (!name)           { showPlanMsg('❌ Plan name is required', true); return }
  if (isNaN(price))    { showPlanMsg('❌ Invalid price', true); return }
  if (isNaN(workers))  { showPlanMsg('❌ Invalid worker count', true); return }

  try {
    showPlanMsg('Saving...', false)
    await api('/api/super/plans/' + id, {
      method: 'PUT',
      body: JSON.stringify({ name, stripe_price_id: stripeId, price_monthly: price, max_workers: workers, features, active })
    })
    showPlanMsg('✅ Saved! Landing page & signup page now reflect these changes.', false)
    await loadPlansPage()
    setTimeout(closePlanModal, 1200)
  } catch(e) {
    showPlanMsg('❌ ' + e.message, true)
  }
}

function showPlanMsg(txt, isErr) {
  const el = document.getElementById('plan-edit-msg')
  el.textContent    = txt
  el.style.display  = 'block'
  el.style.color    = isErr ? '#ef4444' : '#22c55e'
}

</script>
<script src="/static/super-tax.js"></script>
</body>
</html>`
}

// ─── CLOUDFLARE SCHEDULED TRIGGER ────────────────────────────────────────────
// Fires every Friday at 23:59 UTC  →  cron: "59 23 * * 5"
// Also fires every 30 min for Encircle sync  →  cron: "*/30 * * * *"
export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, _ctx: any) {
    const db = env.DB as D1Database
    // Weekly payroll email (Fridays)
    await runWeeklyEmailJob(db, env)
    // Encircle auto-sync (every 30 min — only runs if sync_enabled = 1)
    try {
      const settings = await db.prepare('SELECT sync_enabled FROM encircle_settings WHERE id = 1').first() as any
      if (settings?.sync_enabled === 1) {
        await runEncircleSync(db)
      }
    } catch (_) {
      // Ignore errors in cron — don't fail the whole scheduled event
    }
  }
}

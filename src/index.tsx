import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use('/api/*', cors())

// ─── Static files ─────────────────────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './' }))

// ─── DB Helper ────────────────────────────────────────────────────────────────
async function ensureSchema(db: D1Database) {
  // Run each statement individually (D1 exec doesn't support multi-statement)
  const statements = [
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
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('last_weekly_email_sent', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('geofence_radius_meters', '300')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('gps_fraud_check', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_phone', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_email', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_sms', '0')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_account_sid', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_auth_token', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('twilio_from_number', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('app_host', '')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('max_shift_hours', '10')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('away_warning_min', '30')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_clockout_enabled', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('drift_check_enabled', '1')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('drift_radius_meters', '500')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('geofence_exit_clockout_min', '0')`,
    // invite_code column on workers (safe to run on existing DBs)
    `ALTER TABLE workers ADD COLUMN invite_code TEXT`,
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
  ]
  for (const sql of statements) {
    try {
      await db.prepare(sql).run()
    } catch(e: any) {
      // Ignore "duplicate column" errors from ALTER TABLE on re-runs
      if (!e?.message?.includes('duplicate column')) throw e
    }
  }
}

// ─── WORKERS API ──────────────────────────────────────────────────────────────

// Register or get worker by phone
app.post('/api/workers/register', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { name, phone, pin, device_id } = await c.req.json()

  if (!name || !phone) {
    return c.json({ error: 'Name and phone are required' }, 400)
  }

  // Check if worker exists
  const existing = await db.prepare(
    'SELECT * FROM workers WHERE phone = ?'
  ).bind(phone).first()

  if (existing) {
    return c.json({ worker: existing, isNew: false })
  }

  // Get default hourly rate
  const defaultRate = await db.prepare(
    "SELECT value FROM settings WHERE key = 'default_hourly_rate'"
  ).first<{ value: string }>()

  const result = await db.prepare(
    `INSERT INTO workers (name, phone, pin, device_id, hourly_rate)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    name,
    phone,
    pin || '0000',
    device_id || null,
    parseFloat(defaultRate?.value || '15')
  ).run()

  const worker = await db.prepare(
    'SELECT * FROM workers WHERE id = ?'
  ).bind(result.meta.last_row_id).first()

  return c.json({ worker, isNew: true }, 201)
})

// Lookup worker by phone
app.get('/api/workers/lookup/:phone', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const phone = decodeURIComponent(c.req.param('phone'))

  const worker = await db.prepare(
    'SELECT id, name, phone, hourly_rate, role, active FROM workers WHERE phone = ? AND active = 1'
  ).bind(phone).first()

  if (!worker) return c.json({ error: 'Worker not found' }, 404)
  return c.json({ worker })
})

// Get all workers (admin)
app.get('/api/workers', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)

  const workers = await db.prepare(`
    SELECT w.*,
      COUNT(CASE WHEN s.status = 'active' THEN 1 END) as currently_clocked_in,
      SUM(CASE WHEN s.status = 'completed' THEN s.total_hours ELSE 0 END) as total_hours_all_time,
      SUM(CASE WHEN s.status = 'completed' THEN s.earnings ELSE 0 END) as total_earnings_all_time
    FROM workers w
    LEFT JOIN sessions s ON w.id = s.worker_id
    GROUP BY w.id
    ORDER BY w.created_at DESC
  `).all()

  return c.json({ workers: workers.results })
})

// Update worker
app.put('/api/workers/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  const { name, hourly_rate, role, active } = await c.req.json()

  await db.prepare(
    `UPDATE workers SET name = ?, hourly_rate = ?, role = ?, active = ? WHERE id = ?`
  ).bind(name, hourly_rate, role, active, id).run()

  const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(id).first()
  return c.json({ worker })
})

// Delete worker
app.delete('/api/workers/:id', async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM workers WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ─── SESSIONS API (Clock In / Out) ────────────────────────────────────────────

// ─── INVITE CODE API ──────────────────────────────────────────────────────────

// POST /api/workers/:id/invite  — generate (or regenerate) an invite code
app.post('/api/workers/:id/invite', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const id   = parseInt(c.req.param('id'))
  const code = Math.random().toString(36).substring(2, 8).toUpperCase()   // e.g. "K7XM2P"
  await db.prepare('UPDATE workers SET invite_code = ? WHERE id = ?').bind(code, id).run()
  const worker = await db.prepare('SELECT id, name, phone, invite_code FROM workers WHERE id = ?').bind(id).first() as any
  return c.json({ invite_code: code, worker_name: worker?.name })
})

// GET /api/workers/by-invite/:code  — resolve an invite code → worker data (no auth needed)
app.get('/api/workers/by-invite/:code', async (c) => {
  const db   = c.env.DB
  await ensureSchema(db)
  const code = c.req.param('code').toUpperCase()
  const worker = await db.prepare(
    'SELECT id, name, phone, hourly_rate, role, active, invite_code FROM workers WHERE invite_code = ? AND active = 1'
  ).bind(code).first() as any
  if (!worker) return c.json({ error: 'Invalid or expired invite code' }, 404)
  return c.json({ worker })
})

// GET /invite/:code  — landing page that auto-logs the worker in
app.get('/invite/:code', async (c) => {
  const code = c.req.param('code').toUpperCase()
  // Tiny redirect page: sets localStorage then sends to /
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
  <meta name="theme-color" content="#1e40af"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
  <title>ClockInProof — Joining...</title>
  <link rel="manifest" href="/static/manifest.json"/>
  <link rel="apple-touch-icon" href="/static/icon-192.png"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#1e40af;min-height:100vh;
      display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:24px;padding:40px 32px;text-align:center;
      max-width:360px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2)}
    .icon{width:80px;height:80px;background:#1e40af;border-radius:50%;
      display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:36px}
    h1{font-size:22px;font-weight:700;color:#1e3a8a;margin-bottom:8px}
    p{color:#6b7280;font-size:15px;line-height:1.5;margin-bottom:24px}
    .spinner{width:44px;height:44px;border:4px solid #e0e7ff;border-top-color:#1e40af;
      border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .name{font-size:20px;font-weight:700;color:#1e3a8a;margin:16px 0 4px}
    .sub{color:#6b7280;font-size:14px;margin-bottom:28px}
    .btn{display:block;width:100%;padding:14px;background:#1e40af;color:#fff;
      font-size:16px;font-weight:600;border:none;border-radius:14px;
      cursor:pointer;text-decoration:none;margin-top:8px}
    .btn:hover{background:#1d4ed8}
    .error{color:#dc2626;font-size:14px;margin-top:12px}
    .code-badge{display:inline-block;background:#eff6ff;border:1.5px solid #bfdbfe;
      color:#1e40af;font-family:monospace;font-size:18px;font-weight:700;
      letter-spacing:3px;padding:8px 20px;border-radius:10px;margin:12px 0}
  </style>
</head>
<body>
<div class="card" id="card">
  <div class="icon">⏱</div>
  <h1>ClockInProof</h1>
  <p>Verifying your access code&hellip;</p>
  <div class="spinner" id="spinner"></div>
  <div id="msg" style="display:none"></div>
</div>
<script>
(async () => {
  const code = '${code}'
  const card = document.getElementById('card')
  const spinner = document.getElementById('spinner')
  const msg = document.getElementById('msg')

  try {
    const res  = await fetch('/api/workers/by-invite/' + code)
    const data = await res.json()
    if (!res.ok || !data.worker) {
      spinner.style.display = 'none'
      msg.style.display = 'block'
      msg.innerHTML = '<p class="error"><strong>❌ Invalid invite link.</strong><br>Please ask your manager for a new link.</p>'
      return
    }
    const w = data.worker
    // Persist worker session exactly like normal login
    localStorage.setItem('workerToken', JSON.stringify({ id: w.id, name: w.name, phone: w.phone, hourly_rate: w.hourly_rate || 0, role: w.role || 'worker' }))
    localStorage.setItem('workerId',   w.id)
    localStorage.setItem('workerName', w.name)
    localStorage.setItem('workerPhone', w.phone)

    // Show success + "Open App" button
    spinner.style.display = 'none'
    msg.style.display = 'block'
    msg.innerHTML = \`
      <p class="name">👋 Hi, \${w.name}!</p>
      <p class="sub">Your access code is verified.<br>Tap below to open the app.</p>
      <a href="/" class="btn">📲 Open ClockInProof</a>
      <p style="margin-top:16px;font-size:12px;color:#9ca3af">
        Tip: tap <strong>Share → Add to Home Screen</strong><br>for quick access next time.
      </p>
    \`
    // Auto-redirect in 1.8s
    setTimeout(() => { window.location.href = '/' }, 1800)
  } catch(e) {
    spinner.style.display = 'none'
    msg.style.display = 'block'
    msg.innerHTML = '<p class="error">Connection error. Please try again.</p>'
  }
})()
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
  // Works on desktop browser, Android Chrome, iOS Safari — the hash fragment
  // triggers showTab('overrides') on page load via the window.onload handler.
  const appHost   = env.APP_HOST || ''   // set this Cloudflare secret to your deployed URL
  const deepLink  = appHost ? `${appHost}/admin#overrides` : '/admin#overrides'
  const approveLink = appHost ? `${appHost}/admin#overrides` : '/admin#overrides'

  const workerMapLink = (req.worker_lat && req.worker_lng)
    ? `https://www.google.com/maps?q=${req.worker_lat},${req.worker_lng}`
    : null

  // ── EMAIL via Resend ────────────────────────────────────────────────────────
  if (notifyEmail && adminEmail && env.RESEND_API_KEY) {
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
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${appName} Alerts <alerts@clockinproof.com>`,
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
  // Credentials: prefer Cloudflare env secrets, fall back to DB settings
  const twilioSid   = (env.TWILIO_ACCOUNT_SID   || settings.twilio_account_sid  || '').trim()
  const twilioToken = (env.TWILIO_AUTH_TOKEN     || settings.twilio_auth_token   || '').trim()
  const twilioFrom  = (env.TWILIO_FROM_NUMBER    || settings.twilio_from_number  || '').trim()

  if (notifySms && adminPhone && twilioSid && twilioToken && twilioFrom) {
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
        body: new URLSearchParams({
          From: twilioFrom,
          To: adminPhone.startsWith('+') ? adminPhone : `+${adminPhone}`,
          Body: smsBody
        }).toString()
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
  const { worker_id, latitude, longitude, address, notes, job_location, job_description } = await c.req.json()

  if (!worker_id) return c.json({ error: 'worker_id required' }, 400)
  if (!job_location || !job_location.trim()) return c.json({ error: 'Job location is required' }, 400)
  if (!job_description || !job_description.trim()) return c.json({ error: 'Job description is required' }, 400)

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
  if (fraudCheckEnabled && latitude && longitude) {
    // Geocode the job address the worker typed
    const jobCoords = await geocodeAddress(job_location.trim())

    if (jobCoords) {
      const distanceM = haversineMeters(latitude, longitude, jobCoords.lat, jobCoords.lng)
      const distanceKm = (distanceM / 1000).toFixed(2)

      if (distanceM > geofenceRadius) {
        // ── FRAUD DETECTED: worker is too far from job site ──────────────────
        // Get worker info for the request
        const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(worker_id).first<any>()

        // Save a pending override request
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
          job_location.trim(),
          job_description.trim(),
          latitude, longitude, address || null,
          jobCoords.lat, jobCoords.lng,
          Math.round(distanceM)
        ).run()

        const requestId = reqResult.meta.last_row_id

        // ── SEND ADMIN NOTIFICATION (email + SMS) ────────────────────────────
        // Fire-and-forget — don't block the response while notification sends
        sendOverrideNotification(settings, c.env as any, {
          id: requestId as number,
          worker_name: worker?.name || '',
          worker_phone: worker?.phone || '',
          job_location: job_location.trim(),
          job_description: job_description.trim(),
          distance_meters: Math.round(distanceM),
          worker_address: address || null,
          worker_lat: latitude,
          worker_lng: longitude
        }).catch(() => { /* ignore notification errors — don't block the user */ })

        return c.json({
          error: 'location_mismatch',
          blocked: true,
          request_id: requestId,
          message: `Your current location does not match the job site. You appear to be ${distanceKm} km away from "${job_location}".`,
          worker_location: { lat: latitude, lng: longitude, address: address || null },
          job_location_coords: { lat: jobCoords.lat, lng: jobCoords.lng, address: jobCoords.display },
          distance_km: distanceKm,
          distance_meters: Math.round(distanceM),
          geofence_radius_meters: geofenceRadius,
          override_pending: true,
          override_message: 'A clock-in override request has been sent to your admin. You may only clock in after admin approval.'
        }, 403)
      }
      // Worker is within geofence — proceed, store job coords
    }
    // If geocoding failed (address not found) — allow clock-in but flag it
  }

  // ── NORMAL CLOCK IN ──────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const result = await db.prepare(
    `INSERT INTO sessions
     (worker_id, clock_in_time, clock_in_lat, clock_in_lng, clock_in_address, notes, job_location, job_description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).bind(worker_id, now, latitude || null, longitude || null, address || null, notes || null, job_location.trim(), job_description.trim()).run()

  const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(result.meta.last_row_id).first()
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
  const requests = await db.prepare(
    "SELECT * FROM clock_in_requests WHERE status = 'pending' ORDER BY requested_at DESC"
  ).all()
  return c.json({ requests: requests.results })
})

// Admin: get all override requests (history)
app.get('/api/override/all', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const requests = await db.prepare(
    "SELECT * FROM clock_in_requests ORDER BY requested_at DESC LIMIT 100"
  ).all()
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
  const reason      = `Admin clock-out: ${adminNote}`

  await db.prepare(`
    UPDATE sessions SET
      clock_out_time=?, total_hours=?, earnings=?,
      status='completed', auto_clockout=1, auto_clockout_reason=?,
      notes=CASE WHEN notes IS NULL OR notes='' THEN ? ELSE notes||' | '||? END
    WHERE id=?
  `).bind(
    now.toISOString(),
    Math.round(hoursWorked * 100) / 100,
    Math.round(earnings * 100) / 100,
    reason, reason, reason, id
  ).run()

  // Fetch settings for notifications
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  return c.json({
    success: true,
    message: `${session.worker_name} clocked out by admin`,
    session_id: id,
    total_hours: Math.round(hoursWorked * 100) / 100,
    earnings: Math.round(earnings * 100) / 100,
    reason
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
    const reason      = `${adminNote} (${((s as any).drift_distance_meters / 1000).toFixed(1)}km from site)`

    await db.prepare(`
      UPDATE sessions SET
        clock_out_time=?, total_hours=?, earnings=?,
        status='completed', auto_clockout=1, auto_clockout_reason=?,
        notes=CASE WHEN notes IS NULL OR notes='' THEN ? ELSE notes||' | '||? END
      WHERE id=?
    `).bind(
      now.toISOString(),
      Math.round(hoursWorked * 100) / 100,
      Math.round(earnings * 100) / 100,
      reason, reason, reason, (s as any).id
    ).run()

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

  const sessions = await db.prepare(`
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE s.status = 'active'
    ORDER BY s.clock_in_time DESC
  `).all()

  return c.json({ sessions: sessions.results })
})

// Get all sessions with filters (admin)
app.get('/api/sessions', async (c) => {
  const db = c.env.DB
  const date = c.req.query('date') // YYYY-MM-DD
  const worker_id = c.req.query('worker_id')
  const limit = c.req.query('limit') || '100'

  let query = `
    SELECT s.*, w.name as worker_name, w.phone as worker_phone
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE 1=1
  `
  const params: any[] = []

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

          // Send admin notification about drift
          const worker = await db.prepare('SELECT * FROM workers WHERE id = ?').bind(worker_id).first<any>()
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

      // Notify admin
      const worker = await db.prepare('SELECT * FROM workers WHERE id=?').bind(s.worker_id).first<any>()
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

        results.push(item)
        continue
      }
    }

    // ── 3. GEOFENCE EXIT AUTO-CLOCKOUT ────────────────────────────────────────
    // If worker has been outside the geofence for geofence_exit_clockout_min minutes,
    // automatically clock them out (0 = disabled)
    const exitClockoutMin = parseFloat(settings.geofence_exit_clockout_min || '0')
    if (exitClockoutMin > 0 && s.drift_flag && !s.auto_clockout && s.drift_detected_at) {
      const driftMs = nowMs - new Date(s.drift_detected_at).getTime()
      const driftMinutes = driftMs / (1000 * 60)
      if (driftMinutes >= exitClockoutMin) {
        const earnings = hoursWorked * (s.hourly_rate || 0)
        const dist = s.drift_distance_meters >= 1000
          ? (s.drift_distance_meters / 1000).toFixed(1) + 'km'
          : Math.round(s.drift_distance_meters || 0) + 'm'
        const reason = `Auto clocked out — worker left geofence for ${Math.round(driftMinutes)} min (${dist} from site)`
        await db.prepare(`
          UPDATE sessions SET
            clock_out_time=?, total_hours=?, earnings=?,
            status='completed', auto_clockout=1, auto_clockout_reason=?
          WHERE id=?
        `).bind(now.toISOString(), Math.round(hoursWorked*100)/100, Math.round(earnings*100)/100, reason, s.id).run()
        item.action = 'auto_clocked_out_drift'
        item.reason = reason
        item.hours  = Math.round(hoursWorked*10)/10

        sendOverrideNotification(settings, env, {
          id: s.id,
          worker_name: s.worker_name,
          worker_phone: s.worker_phone,
          job_location: s.job_location || 'Unknown',
          job_description: `📍 GEOFENCE AUTO CLOCK-OUT: Worker was ${dist} outside the job site for ${Math.round(driftMinutes)} min. Session automatically closed. Hours recorded: ${item.hours}h. Task: ${s.job_description || 'N/A'}`,
          distance_meters: s.drift_distance_meters || 0,
          worker_address: null,
          worker_lat: null,
          worker_lng: null
        }).catch(() => {})

        results.push(item)
        continue
      }
    }

    // ── 4. AWAY/IDLE FLAG ────────────────────────────────────────────────────
    // Check when last ping was received — if too long ago, flag as away
    const lastPing = await db.prepare(
      'SELECT timestamp FROM location_pings WHERE session_id=? ORDER BY timestamp DESC LIMIT 1'
    ).bind(s.id).first<any>()

    const lastPingMs = lastPing
      ? new Date(lastPing.timestamp).getTime()
      : clockInMs   // no pings yet: use clock-in time

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
  const sites = await db.prepare(
    'SELECT * FROM job_sites WHERE active = 1 ORDER BY name ASC'
  ).all()
  return c.json({ sites: sites.results })
})

app.post('/api/job-sites', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
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
    'INSERT INTO job_sites (name, address, lat, lng) VALUES (?, ?, ?, ?)'
  ).bind(name.trim(), address.trim(), lat, lng).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.put('/api/job-sites/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
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
    WHERE id = ?`
  ).bind(
    name?.trim() || null,
    address?.trim() || null,
    address ? lat : null, lat,
    address ? lng : null, lng,
    active !== undefined ? (active ? 1 : 0) : null,
    id
  ).run()
  return c.json({ success: true })
})

app.delete('/api/job-sites/:id', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  await db.prepare('UPDATE job_sites SET active = 0 WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ success: true })
})

// ─── FEATURE 3: WORKER DISPUTE / ISSUE REPORTS ───────────────────────────────

app.post('/api/disputes', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { session_id, worker_id, message } = await c.req.json().catch(() => ({})) as any
  if (!session_id || !worker_id || !message?.trim()) {
    return c.json({ error: 'session_id, worker_id and message are required' }, 400)
  }
  const worker = await db.prepare('SELECT name FROM workers WHERE id = ?').bind(worker_id).first() as any
  await db.prepare(
    `INSERT INTO session_disputes (session_id, worker_id, worker_name, message) VALUES (?, ?, ?, ?)`
  ).bind(session_id, worker_id, worker?.name || 'Worker', message.trim()).run()
  return c.json({ success: true, message: 'Your report has been sent to admin.' })
})

app.get('/api/disputes', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const status = c.req.query('status') || 'pending'
  const disputes = await db.prepare(
    `SELECT d.*, s.clock_in_time, s.clock_out_time, s.total_hours, s.earnings, s.job_location
     FROM session_disputes d
     LEFT JOIN sessions s ON s.id = d.session_id
     WHERE d.status = ?
     ORDER BY d.created_at DESC`
  ).bind(status).all()
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
    WHERE 1=1 ${dateFilter}
  `).first()

  const workerCount = await db.prepare('SELECT COUNT(*) as count FROM workers WHERE active = 1').first<{count: number}>()

  return c.json({ stats: { ...stats, total_workers: workerCount?.count || 0 }, period })
})

app.get('/api/stats/worker/:worker_id', async (c) => {
  const db = c.env.DB
  const worker_id = c.req.param('worker_id')

  const stats = await db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(CASE WHEN status = 'completed' THEN total_hours ELSE 0 END) as total_hours,
      SUM(CASE WHEN status = 'completed' THEN earnings ELSE 0 END) as total_earnings,
      MAX(clock_in_time) as last_clock_in
    FROM sessions
    WHERE worker_id = ?
  `).bind(worker_id).first()

  return c.json({ stats })
})

// ─── SETTINGS API ─────────────────────────────────────────────────────────────

app.get('/api/settings', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const settings = await db.prepare('SELECT * FROM settings').all()
  const obj: Record<string, string> = {}
  settings.results.forEach((s: any) => { obj[s.key] = s.value })
  return c.json({ settings: obj })
})

app.put('/api/settings', async (c) => {
  const db = c.env.DB
  const body = await c.req.json()

  for (const [key, value] of Object.entries(body)) {
    await db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    ).bind(key, String(value)).run()
  }

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
  const year = parseInt(c.req.param('year'))
  const month = parseInt(c.req.param('month'))
  const worker_id = c.req.query('worker_id')

  const startDate = `${year}-${String(month).padStart(2,'0')}-01`
  const endDate = new Date(year, month, 0).toISOString().split('T')[0] // last day of month

  let query = `
    SELECT s.*, w.name as worker_name, w.phone as worker_phone, w.hourly_rate
    FROM sessions s JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ? AND DATE(s.clock_in_time) <= ?
    AND s.status = 'completed'
  `
  const params: any[] = [startDate, endDate]
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
  const weekParam   = c.req.query('week')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const workerFilter = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds = workerId ? [bounds.start, bounds.end, workerId] : [bounds.start, bounds.end]

  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
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
    ORDER BY lp.session_id, lp.timestamp ASC
  `).bind(bounds.start, bounds.end).all()

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

// GET /api/export/weekly/html?week=YYYY-MM-DD
// Returns a printable HTML proof report
app.get('/api/export/weekly/html', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const weekParam   = c.req.query('week')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds      = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const workerFilter  = workerId ? 'AND s.worker_id = ?' : ''
  const sessionBinds  = workerId ? [bounds.start, bounds.end, workerId] : [bounds.start, bounds.end]

  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
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

// GET /api/export/csv?week=YYYY-MM-DD&worker_id=N
// Returns a CSV file attachment (all staff or a single worker)
app.get('/api/export/csv', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const weekParam   = c.req.query('week')
  const workerIdRaw = c.req.query('worker_id')
  const workerId    = workerIdRaw ? parseInt(workerIdRaw) : null
  const bounds      = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

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

// ─── SCHEDULED WEEKLY EMAIL (Cloudflare Cron Trigger) ─────────────────────────
// Configured in wrangler.jsonc as:  "triggers": { "crons": ["59 23 * * FRI"] }
// Runs every Friday at 11:59 PM UTC → sends Mon–Fri weekly report
async function runWeeklyEmailJob(db: D1Database, env: any) {
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const adminEmail = settings.admin_email || ''
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
  const appName  = settings.app_name || 'ClockInProof'
  const subject  = `${appName} — Weekly Report: ${bounds.label}`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${appName} <reports@clockinproof.com>`,
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

// ─── MAIN PAGES ───────────────────────────────────────────────────────────────

// Worker mobile app (clock in/out)
app.get('/', (c) => {
  return c.html(getWorkerHTML())
})

// Admin dashboard
app.get('/admin', (c) => {
  return c.html(getAdminHTML())
})

// ─── HTML Templates ───────────────────────────────────────────────────────────

function getWorkerHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
  <meta name="theme-color" content="#1e40af"/>
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
  <meta name="apple-mobile-web-app-title" content="ClockInProof"/>
  <title>ClockInProof — Clock In/Out</title>
  <link rel="manifest" href="/static/manifest.json"/>
  <link rel="apple-touch-icon" href="/static/icon-180.png"/>
  <link rel="apple-touch-icon" sizes="192x192" href="/static/icon-192.png"/>
  <link rel="icon" type="image/png" sizes="192x192" href="/static/icon-192.png"/>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; }
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
        <label class="block text-sm font-medium text-gray-700 mb-1">4-Digit PIN</label>
        <input id="reg-pin" type="password" placeholder="Create a PIN" maxlength="4"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"/>
      </div>
      <button onclick="registerWorker()" id="reg-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl clock-btn shadow-md">
        <i class="fas fa-user-plus mr-2"></i>Get Started
      </button>
      <button onclick="showLogin()" class="w-full text-blue-600 hover:text-blue-700 font-medium py-2 text-sm">
        Already registered? Sign in
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
        <input id="login-pin" type="password" placeholder="Enter your PIN" maxlength="4"
          class="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"/>
      </div>
      <button onclick="loginWorker()" id="login-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl clock-btn shadow-md">
        <i class="fas fa-sign-in-alt mr-2"></i>Sign In
      </button>
      <button onclick="showRegister()" class="w-full text-blue-600 font-medium py-2 text-sm">
        New user? Register here
      </button>
    </div>
  </div>
</div>

<!-- Main Worker Screen -->
<div id="screen-main" class="hidden min-h-screen bg-gray-50">
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
        <button onclick="clockOut()" class="bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold px-3 py-2 rounded-xl flex-shrink-0">
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
            <button onclick="clockOut()" class="bg-white border border-yellow-400 text-yellow-700 text-xs font-medium px-3 py-1.5 rounded-lg">
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
        <button onclick="clockOut()" class="bg-red-500 hover:bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-xl flex-shrink-0">
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
      <div id="map-wrapper" class="hidden mt-3">
        <div class="flex items-center justify-between mb-1.5">
          <p class="text-xs text-gray-400 font-medium">Your current position</p>
          <button onclick="closeMap()" class="text-gray-400 hover:text-gray-600 text-xs flex items-center gap-1 bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-lg transition-colors">
            <i class="fas fa-times"></i> Close map
          </button>
        </div>
        <div id="map" class="rounded-xl overflow-hidden" style="height:200px"></div>
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

    <div class="text-center py-4">
      <a href="/admin" class="text-gray-400 text-xs hover:text-gray-600">
        <i class="fas fa-shield-alt mr-1"></i>Admin Panel
      </a>
    </div>
  </div>
</div>

<!-- ── Clock In Job Details Modal ─────────────────────────────────────────── -->
<div id="job-modal" class="hidden fixed inset-0 bg-black bg-opacity-60 modal-bg flex items-end justify-center z-50">
  <div class="bg-white w-full max-w-lg rounded-t-3xl shadow-2xl p-6 slide-up" style="max-height:90vh;overflow-y:auto">
    <div class="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-5"></div>
    <div class="flex items-center gap-3 mb-5">
      <div class="w-12 h-12 bg-green-100 rounded-2xl flex items-center justify-center">
        <i class="fas fa-briefcase text-green-600 text-xl"></i>
      </div>
      <div>
        <h3 class="text-lg font-bold text-gray-800">Where are you working?</h3>
        <p class="text-gray-500 text-xs">Tell us about today's job before clocking in</p>
      </div>
    </div>

    <!-- Job Location -->
    <div class="mb-4">
      <label class="block text-sm font-semibold text-gray-700 mb-2">
        <i class="fas fa-map-marker-alt text-red-500 mr-1"></i>Job Location / Address
      </label>
      <!-- Saved sites dropdown (shown when sites exist) -->
      <div id="saved-sites-row" class="hidden mb-2">
        <select id="saved-sites-select" onchange="pickSavedSite(this.value)"
          class="w-full px-4 py-3 border-2 border-emerald-200 rounded-xl focus:outline-none focus:border-emerald-500 text-gray-800 text-sm bg-emerald-50">
          <option value="">📍 Pick a saved job site...</option>
        </select>
      </div>
      <input id="job-location-input" type="text"
        placeholder="e.g. 123 Ryan Street, Building 4"
        class="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 text-gray-800 text-sm"
        oninput="filterLocationSuggestions(this.value)"/>
      <!-- Recent locations dropdown -->
      <div id="location-suggestions" class="hidden mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-10"></div>
    </div>

    <!-- Tasks / Description -->
    <div class="mb-5">
      <label class="block text-sm font-semibold text-gray-700 mb-2">
        <i class="fas fa-tasks text-blue-500 mr-1"></i>What are you doing today?
      </label>
      <textarea id="job-description-input" rows="3"
        placeholder="e.g. Installing floor tiles in bedroom, drywall in bathroom, painting hallway"
        class="w-full px-4 py-3.5 border-2 border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 text-gray-800 text-sm resize-none"></textarea>
      <p class="text-xs text-gray-400 mt-1">Be specific — this helps track what was done each day</p>
    </div>

    <!-- Quick task chips -->
    <div class="mb-5">
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
    <div class="bg-gray-50 rounded-xl p-3 mb-5 flex items-center gap-3">
      <i class="fas fa-map-marker-alt text-red-500"></i>
      <div class="flex-1">
        <p class="text-xs font-medium text-gray-700">GPS will be captured automatically</p>
        <p id="modal-gps-status" class="text-xs text-gray-400 mt-0.5">
          Getting your location...
        </p>
      </div>
    </div>

    <div class="flex gap-3">
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
<div id="dispute-modal" class="hidden fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4">
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

<div id="fraud-blocked-modal" class="hidden fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4">
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
<div id="toast" class="hidden fixed bottom-6 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium max-w-xs text-center"></div>

<script>
let currentWorker = null
let activeSession = null
let currentLat = null
let currentLng = null
let currentAddress = null
let map = null
let marker = null
let durationTimer = null
let pingInterval = null
let recentLocations = []
// GPS fraud override state
let pendingOverrideId = null
let overridePollTimer = null
let fraudMap = null

// ── Init ──────────────────────────────────────────────────────────────────────
window.onload = async () => {
  const saved = localStorage.getItem('wt_worker')
  recentLocations = JSON.parse(localStorage.getItem('wt_recent_locations') || '[]')
  if (saved) {
    currentWorker = JSON.parse(saved)
    await initMain()
  } else {
    showScreen('register')
  }
  getLocation()
}

function showScreen(name) {
  ['register','login','main'].forEach(s => {
    document.getElementById('screen-' + s).classList.add('hidden')
  })
  document.getElementById('screen-' + name).classList.remove('hidden')
}
function showLogin() { showScreen('login') }
function showRegister() { showScreen('register') }

// ── Register ──────────────────────────────────────────────────────────────────
async function registerWorker() {
  const name = document.getElementById('reg-name').value.trim()
  const phone = document.getElementById('reg-phone').value.trim()
  const pin = document.getElementById('reg-pin').value.trim()
  if (!name || !phone) { showToast('Please enter name and phone', 'error'); return }
  if (pin && pin.length !== 4) { showToast('PIN must be 4 digits', 'error'); return }
  const btn = document.getElementById('reg-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Please wait...'
  try {
    const res = await fetch('/api/workers/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, pin: pin || '0000', device_id: getDeviceId() })
    })
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      showToast(data.isNew ? 'Registered! Welcome 🎉' : 'Welcome back!', 'success')
      await initMain()
    } else { showToast(data.error || 'Registration failed', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-user-plus mr-2"></i>Get Started'
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function loginWorker() {
  const phone = document.getElementById('login-phone').value.trim()
  if (!phone) { showToast('Enter your phone number', 'error'); return }
  const btn = document.getElementById('login-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Signing in...'
  try {
    const res = await fetch('/api/workers/lookup/' + encodeURIComponent(phone))
    const data = await res.json()
    if (data.worker) {
      currentWorker = data.worker
      localStorage.setItem('wt_worker', JSON.stringify(data.worker))
      showToast('Welcome back, ' + data.worker.name + '!', 'success')
      await initMain()
    } else { showToast('Worker not found. Please register first.', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Sign In'
}

function logout() {
  localStorage.removeItem('wt_worker')
  currentWorker = null; activeSession = null
  clearInterval(durationTimer); clearInterval(pingInterval)
  stopWatchdog(); hideAllBanners()
  showScreen('register')
}

// ── Main Init ─────────────────────────────────────────────────────────────────
async function initMain() {
  showScreen('main')
  document.getElementById('worker-name-display').textContent = currentWorker.name
  document.getElementById('worker-phone-display').textContent = currentWorker.phone
  document.getElementById('worker-rate-display').textContent = '$' + (currentWorker.hourly_rate || 0).toFixed(2) + '/hr'
  await checkStatus()
  await loadStats()
  await loadWorkLog()
}

async function checkStatus() {
  try {
    const res = await fetch('/api/sessions/status/' + currentWorker.id)
    const data = await res.json()
    activeSession = data.active_session
    if (data.is_clocked_in && activeSession) {
      setClockedInUI(true)
      startDurationTimer()
      startPingInterval()
      startWatchdog()
    } else {
      setClockedInUI(false)
    }
  } catch(e) { console.error(e) }
}

function setClockedInUI(isClockedIn) {
  const btn = document.getElementById('clock-btn')
  const dot = document.getElementById('status-dot')
  const txt = document.getElementById('status-text')
  const icon = document.getElementById('clock-btn-icon')
  const btnTxt = document.getElementById('clock-btn-text')
  const info = document.getElementById('clock-in-info')
  const jobBanner = document.getElementById('active-job-banner')

  if (isClockedIn) {
    btn.className = 'w-full py-5 rounded-2xl text-white text-xl font-bold shadow-lg clock-btn flex items-center justify-center gap-3 bg-red-500 hover:bg-red-600'
    dot.className = 'w-3 h-3 rounded-full bg-green-500 pulse'
    txt.textContent = 'Currently Working'
    txt.className = 'font-semibold text-green-600'
    icon.className = 'fas fa-stop-circle text-2xl'
    btnTxt.textContent = 'Clock Out'
    info.classList.remove('hidden')
    if (activeSession) {
      const t = new Date(activeSession.clock_in_time)
      document.getElementById('session-start-time').textContent = t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
      // Show job banner
      if (activeSession.job_location) {
        jobBanner.classList.remove('hidden')
        document.getElementById('active-job-location').textContent = '📍 ' + activeSession.job_location
        document.getElementById('active-job-desc').textContent = activeSession.job_description || ''
      }
    }
  } else {
    btn.className = 'w-full py-5 rounded-2xl text-white text-xl font-bold shadow-lg clock-btn flex items-center justify-center gap-3 bg-green-500 hover:bg-green-600'
    dot.className = 'w-3 h-3 rounded-full bg-gray-300'
    txt.textContent = 'Not Clocked In'
    txt.className = 'font-semibold text-gray-700'
    icon.className = 'fas fa-play-circle text-2xl'
    btnTxt.textContent = 'Clock In'
    info.classList.add('hidden')
    jobBanner.classList.add('hidden')
    clearInterval(durationTimer)
    clearInterval(pingInterval)
  }
}

// ── Clock Button Handler ───────────────────────────────────────────────────────
function handleClockBtn() {
  if (!activeSession) {
    openJobModal()  // Show job details form before clocking in
  } else {
    clockOut()      // Clock out directly
  }
}

// ── Job Details Modal ─────────────────────────────────────────────────────────
function openJobModal() {
  document.getElementById('job-modal').classList.remove('hidden')
  document.getElementById('job-location-input').value = ''
  document.getElementById('job-description-input').value = ''
  document.getElementById('location-suggestions').classList.add('hidden')
  // Update GPS status in modal
  const gpsEl = document.getElementById('modal-gps-status')
  if (gpsEl) {
    gpsEl.textContent = currentLat
      ? \`✓ Location ready (±\${currentLat.toFixed(3)}...)\`
      : 'Getting location...'
  }
  // Pre-fill with most recent location
  if (recentLocations.length > 0) {
    document.getElementById('job-location-input').value = recentLocations[0]
  }
  // Load saved job sites from admin
  loadSavedSitesDropdown()
  setTimeout(() => document.getElementById('job-location-input').focus(), 300)
}

async function loadSavedSitesDropdown() {
  try {
    const res  = await fetch('/api/job-sites')
    const data = await res.json()
    const sites = data.sites || []
    const row = document.getElementById('saved-sites-row')
    const sel = document.getElementById('saved-sites-select')
    if (!row || !sel) return
    if (sites.length === 0) { row.classList.add('hidden'); return }
    sel.innerHTML = '<option value="">📍 Pick a saved job site...</option>' +
      sites.map(s => \`<option value="\${s.address}">\${s.name} — \${s.address}</option>\`).join('')
    row.classList.remove('hidden')
  } catch(_) {}
}

function pickSavedSite(address) {
  if (!address) return
  document.getElementById('job-location-input').value = address
  document.getElementById('location-suggestions').classList.add('hidden')
}

function closeJobModal() {
  document.getElementById('job-modal').classList.add('hidden')
}

// Close modal on backdrop click
document.getElementById('job-modal').addEventListener('click', function(e) {
  if (e.target === this) closeJobModal()
})

function addChip(task) {
  const el = document.getElementById('job-description-input')
  const current = el.value.trim()
  if (current) {
    el.value = current.endsWith(',') ? current + ' ' + task : current + ', ' + task
  } else {
    el.value = task
  }
  el.focus()
}

function filterLocationSuggestions(val) {
  const box = document.getElementById('location-suggestions')
  if (!val || recentLocations.length === 0) { box.classList.add('hidden'); return }
  const filtered = recentLocations.filter(l => l.toLowerCase().includes(val.toLowerCase()))
  if (filtered.length === 0) { box.classList.add('hidden'); return }
  box.innerHTML = filtered.map((l, i) => {
    const safeId = 'loc-sug-' + i
    return \`<button id="\${safeId}" data-loc="\${l.replace(/"/g,'&quot;')}"
      class="w-full text-left px-4 py-3 hover:bg-blue-50 text-sm text-gray-700 border-b border-gray-100 last:border-0"
      onclick="selectLocation(this.dataset.loc)">
      <i class="fas fa-history text-gray-400 mr-2 text-xs"></i>\${l}
    </button>\`
  }).join('')
  box.classList.remove('hidden')
}

function selectLocation(loc) {
  document.getElementById('job-location-input').value = loc
  document.getElementById('location-suggestions').classList.add('hidden')
}

async function confirmClockIn() {
  const jobLocation = document.getElementById('job-location-input').value.trim()
  const jobDescription = document.getElementById('job-description-input').value.trim()

  if (!jobLocation) { showToast('Please enter the job location', 'error'); document.getElementById('job-location-input').focus(); return }
  if (!jobDescription) { showToast('Please describe what you are doing', 'error'); document.getElementById('job-description-input').focus(); return }

  const btn = document.getElementById('confirm-clock-in-btn')
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Verifying location...'

  try {
    const res = await fetch('/api/sessions/clock-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: currentWorker.id,
        latitude: currentLat,
        longitude: currentLng,
        address: currentAddress,
        job_location: jobLocation,
        job_description: jobDescription
      })
    })
    const data = await res.json()

    // ── GPS FRAUD BLOCKED ─────────────────────────────────────────────────────
    if (res.status === 403 && data.error === 'location_mismatch') {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-play-circle mr-2"></i>Start Working'
      closeJobModal()
      showFraudBlockedModal(data)
      return
    }

    // ── NORMAL SUCCESS ────────────────────────────────────────────────────────
    if (data.session) {
      activeSession = data.session
      // Save location to recent list
      if (!recentLocations.includes(jobLocation)) {
        recentLocations.unshift(jobLocation)
        recentLocations = recentLocations.slice(0, 10)
        localStorage.setItem('wt_recent_locations', JSON.stringify(recentLocations))
      }
      closeJobModal()
      setClockedInUI(true)
      startDurationTimer()
      startPingInterval()
      startWatchdog()
      showToast('Clocked in! Have a great shift \u{1F4AA}', 'success')
      await loadStats()
      await loadWorkLog()
    } else {
      showToast(data.error || 'Failed to clock in', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-play-circle mr-2"></i>Start Working'
}

// ── Fraud Blocked Modal ────────────────────────────────────────────────────────
function showFraudBlockedModal(data) {
  pendingOverrideId = data.request_id || null

  // Populate distance message
  const distKm = parseFloat(data.distance_km || 0)
  const distM  = parseInt(data.distance_meters || 0)
  const radius = parseInt(data.geofence_radius_meters || 300)
  document.getElementById('fraud-distance-msg').textContent =
    'You are ' + (distM >= 1000 ? distKm + ' km' : distM + ' m') + ' from the job site. Required: within ' + radius + ' m.'

  // Your location label
  const yourLoc = data.worker_location
  document.getElementById('fraud-your-loc').textContent =
    yourLoc && yourLoc.address ? yourLoc.address.substring(0, 60) + '...' :
    (yourLoc ? yourLoc.lat.toFixed(5) + ', ' + yourLoc.lng.toFixed(5) : 'Unknown')

  // Job site label
  const jobLoc = data.job_location_coords
  document.getElementById('fraud-job-loc').textContent =
    jobLoc && jobLoc.address ? jobLoc.address.substring(0, 60) + '...' :
    (jobLoc ? jobLoc.lat.toFixed(5) + ', ' + jobLoc.lng.toFixed(5) : 'Unknown')

  // Show initial "request sent" panel, hide pending
  document.getElementById('fraud-request-sent').classList.remove('hidden')
  document.getElementById('fraud-pending').classList.add('hidden')
  document.getElementById('fraud-wait-btn').classList.remove('hidden')

  // Show modal
  document.getElementById('fraud-blocked-modal').classList.remove('hidden')

  // Draw map with two markers after a tick
  setTimeout(() => {
    if (fraudMap) { fraudMap.remove(); fraudMap = null }
    const mapEl = document.getElementById('fraud-map')
    if (yourLoc && jobLoc && window.L) {
      const midLat = (yourLoc.lat + jobLoc.lat) / 2
      const midLng = (yourLoc.lng + jobLoc.lng) / 2
      fraudMap = L.map(mapEl).setView([midLat, midLng], 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(fraudMap)
      // Worker marker (blue)
      const workerIcon = L.divIcon({ className: '', html: '<div style="background:#3b82f6;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>', iconSize:[14,14], iconAnchor:[7,7] })
      L.marker([yourLoc.lat, yourLoc.lng], { icon: workerIcon }).addTo(fraudMap).bindPopup('You are here')
      // Job site marker (red)
      const jobIcon = L.divIcon({ className: '', html: '<div style="background:#ef4444;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>', iconSize:[14,14], iconAnchor:[7,7] })
      L.marker([jobLoc.lat, jobLoc.lng], { icon: jobIcon }).addTo(fraudMap).bindPopup('Job site')
      // Line between them
      L.polyline([[yourLoc.lat, yourLoc.lng],[jobLoc.lat, jobLoc.lng]], { color:'#ef4444', weight:2, dashArray:'6,4' }).addTo(fraudMap)
      // Fit bounds
      fraudMap.fitBounds([[yourLoc.lat, yourLoc.lng],[jobLoc.lat, jobLoc.lng]], { padding:[20,20] })
    } else {
      mapEl.innerHTML = '<div class="flex items-center justify-center h-full text-gray-400 text-sm"><i class="fas fa-map-marked-alt mr-2"></i>Map unavailable</div>'
    }
  }, 200)
}

function closeFraudModal() {
  document.getElementById('fraud-blocked-modal').classList.add('hidden')
  stopOverridePolling()
  if (fraudMap) { fraudMap.remove(); fraudMap = null }
}

function startOverridePolling() {
  if (!pendingOverrideId) return
  document.getElementById('fraud-request-sent').classList.add('hidden')
  document.getElementById('fraud-pending').classList.remove('hidden')
  document.getElementById('fraud-wait-btn').classList.add('hidden')
  stopOverridePolling()
  pollOverrideStatus()
  overridePollTimer = setInterval(pollOverrideStatus, 15000)
}

function stopOverridePolling() {
  if (overridePollTimer) { clearInterval(overridePollTimer); overridePollTimer = null }
}

async function pollOverrideStatus() {
  if (!pendingOverrideId) return
  document.getElementById('fraud-poll-status').textContent = 'Checking... ' + new Date().toLocaleTimeString()
  try {
    const res = await fetch('/api/override/status/' + pendingOverrideId)
    const data = await res.json()
    const req = data.request
    if (!req) return

    if (req.status === 'approved') {
      stopOverridePolling()
      closeFraudModal()
      // Fetch the newly created session
      const sRes = await fetch('/api/sessions/status/' + currentWorker.id)
      const sData = await sRes.json()
      if (sData.active_session) {
        activeSession = sData.active_session
        setClockedInUI(true)
        startDurationTimer()
        startPingInterval()
        startWatchdog()
        showToast('\u2705 Admin approved! You are now clocked in.', 'success')
        await loadStats()
        await loadWorkLog()
      }
    } else if (req.status === 'denied') {
      stopOverridePolling()
      closeFraudModal()
      showToast('\u274C Admin denied your clock-in request. Contact your supervisor.', 'error')
    }
  } catch(e) {
    document.getElementById('fraud-poll-status').textContent = 'Checking every 15 seconds...'
  }
}

// ── Clock Out ─────────────────────────────────────────────────────────────────
async function clockOut() {
  const btn = document.getElementById('clock-btn')
  btn.disabled = true
  try {
    const res = await fetch('/api/sessions/clock-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        worker_id: currentWorker.id,
        latitude: currentLat,
        longitude: currentLng,
        address: currentAddress
      })
    })
    const data = await res.json()
    if (data.session) {
      const hrs = (data.total_hours || 0).toFixed(2)
      const earned = '$' + (data.earnings || 0).toFixed(2)
      activeSession = null
      stopWatchdog()
      clearInterval(durationTimer)
      clearInterval(pingInterval)
      hideAllBanners()
      setClockedInUI(false)
      showToast(\`Clocked out! \${hrs}h worked · \${earned} earned 🎉\`, 'success')
      await loadStats()
      await loadWorkLog()
    } else { showToast(data.error || 'Failed to clock out', 'error') }
  } catch(e) { showToast('Connection error', 'error') }
  btn.disabled = false
}

// ── Duration Timer ────────────────────────────────────────────────────────────
function startDurationTimer() {
  clearInterval(durationTimer)
  durationTimer = setInterval(() => {
    if (!activeSession) return
    const diff = (new Date() - new Date(activeSession.clock_in_time)) / 1000
    const h = Math.floor(diff / 3600)
    const m = Math.floor((diff % 3600) / 60)
    const s = Math.floor(diff % 60)
    document.getElementById('session-duration').textContent = \`\${h}h \${m}m \${s}s\`
    document.getElementById('session-earnings').textContent = '$' + ((diff / 3600) * (currentWorker.hourly_rate || 0)).toFixed(2)
  }, 1000)
}

// ── Location ──────────────────────────────────────────────────────────────────
function getLocation() {
  if (!navigator.geolocation) {
    document.getElementById('location-status').innerHTML = '<i class="fas fa-exclamation-circle text-red-500 mr-1"></i> GPS not supported'
    return
  }
  document.getElementById('location-status').innerHTML = '<i class="fas fa-circle-notch spinner mr-1"></i> Getting location...'
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      currentLat = pos.coords.latitude
      currentLng = pos.coords.longitude
      const acc = Math.round(pos.coords.accuracy)
      document.getElementById('location-status').innerHTML =
        \`<i class="fas fa-check-circle text-green-500 mr-1"></i> <span class="text-gray-700 font-medium">\${currentLat.toFixed(5)}, \${currentLng.toFixed(5)}</span> <span class="text-xs text-gray-400">±\${acc}m</span>\`
      try {
        const geo = await fetch(\`https://nominatim.openstreetmap.org/reverse?lat=\${currentLat}&lon=\${currentLng}&format=json\`)
        const gd = await geo.json()
        if (gd.display_name) {
          currentAddress = gd.display_name
          document.getElementById('location-status').innerHTML =
            \`<i class="fas fa-map-marker-alt text-red-500 mr-1"></i> <span class="text-gray-700 text-xs">\${gd.display_name.substring(0,80)}...</span> <span class="text-xs text-gray-400">±\${acc}m</span>\`
        }
      } catch(e) {}
      showMap(currentLat, currentLng)
    },
    () => {
      document.getElementById('location-status').innerHTML = '<i class="fas fa-exclamation-triangle text-yellow-500 mr-1"></i> Location access denied'
      currentLat = null; currentLng = null
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  )
}

function showMap(lat, lng) {
  // Store coords for lazy map render — don't auto-open the map
  // Just reveal the "View Map" button so the user can open it on demand
  const toggleBtn = document.getElementById('toggle-map-btn')
  if (toggleBtn) toggleBtn.classList.remove('hidden')
  // If map is already open, refresh it in place
  const wrapper = document.getElementById('map-wrapper')
  if (wrapper && !wrapper.classList.contains('hidden')) {
    renderMap(lat, lng)
  }
}

function renderMap(lat, lng) {
  const mapEl = document.getElementById('map')
  if (!mapEl) return
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)
  }
  map.setView([lat, lng], 16)
  if (marker) marker.remove()
  marker = L.circleMarker([lat, lng], { color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.8, radius: 10 }).addTo(map)
  // Force Leaflet to recalculate size after reveal
  setTimeout(() => { if (map) map.invalidateSize() }, 50)
}

function toggleMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (!wrapper) return
  if (wrapper.classList.contains('hidden')) {
    wrapper.classList.remove('hidden')
    btn.innerHTML = '<i class="fas fa-map mr-1"></i>Hide Map'
    if (currentLat && currentLng) renderMap(currentLat, currentLng)
  } else {
    closeMap()
  }
}

function closeMap() {
  const wrapper = document.getElementById('map-wrapper')
  const btn = document.getElementById('toggle-map-btn')
  if (wrapper) wrapper.classList.add('hidden')
  if (btn) btn.innerHTML = '<i class="fas fa-map mr-1"></i>View Map'
}

function startPingInterval() {
  clearInterval(pingInterval)
  pingInterval = setInterval(async () => {
    if (!activeSession || !currentLat) return
    try {
      const res = await fetch('/api/location/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeSession.id, worker_id: currentWorker.id, latitude: currentLat, longitude: currentLng })
      })
      const pingData = await res.json()
      // Show drift banner if server detected worker has left the job site
      if (pingData.drift_detected) {
        const distTxt = pingData.drift_distance_meters >= 1000
          ? (pingData.drift_distance_meters / 1000).toFixed(1) + ' km'
          : pingData.drift_distance_meters + ' m'
        showGuardrailBanner('drift', 'You are ' + distTxt + ' away from "' + (activeSession.job_location || 'the job site') + '".')
      }
      getLocation()
    } catch(e) {}
  }, 5 * 60 * 1000)  // ping every 5 min
}

// ── Guardrail Watchdog (runs every 60s while clocked in) ──────────────────────
let watchdogTimer = null
let lastPingTime  = Date.now()

function startWatchdog() {
  stopWatchdog()
  lastPingTime = Date.now()
  watchdogTimer = setInterval(async () => {
    if (!activeSession || !currentWorker) return
    try {
      const res = await fetch('/api/sessions/watchdog')
      const data = await res.json()
      const myResult = (data.results || []).find(r => r.session_id === activeSession?.id)

      if (!myResult) {
        // Session no longer active — was auto-clocked out by server
        clearInterval(watchdogTimer)
        clearInterval(durationTimer)
        clearInterval(pingInterval)
        activeSession = null
        setClockedInUI(false)
        hideAllBanners()
        showToast('You have been automatically clocked out by the system.', 'info')
        await loadStats()
        await loadWorkLog()
        return
      }

      const hoursWorked   = myResult.hours_worked || 0
      const maxShiftHours = myResult.max_shift_hours || 10
      const hoursLeft     = maxShiftHours - hoursWorked

      // Max shift warning — show 30 min before limit
      if (hoursLeft <= 0.5 && hoursLeft > 0) {
        const minsLeft = Math.round(hoursLeft * 60)
        showGuardrailBanner('maxshift', 'You have worked ' + hoursWorked.toFixed(1) + 'h. Auto clock-out in ' + minsLeft + ' minutes.')
      } else {
        hideBanner('maxshift')
      }

      // Away detection — based on time since last ping from this device
      const minsSinceDevicePing = (Date.now() - lastPingTime) / (1000 * 60)
      const awayThreshold = 30  // matches server setting
      if (minsSinceDevicePing >= awayThreshold) {
        showGuardrailBanner('away', 'No GPS update for ' + Math.round(minsSinceDevicePing) + ' minutes.')
      } else {
        hideBanner('away')
      }

      // Drift banner (set by ping response, kept visible)
      if (!myResult.drift_flag) hideBanner('drift')

    } catch(e) {}
  }, 60 * 1000)  // check every 60s
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
}

function showGuardrailBanner(type, msg) {
  const banner = document.getElementById('banner-' + type)
  const msgEl  = document.getElementById('banner-' + type + '-msg')
  if (!banner) return
  if (msgEl && msg) msgEl.textContent = msg
  banner.classList.remove('hidden')
}

function hideBanner(type) {
  const banner = document.getElementById('banner-' + type)
  if (banner) banner.classList.add('hidden')
}

function hideAllBanners() {
  ['drift','away','maxshift'].forEach(t => hideBanner(t))
}

async function confirmStillWorking() {
  // Worker tapped "Yes, still here" — refresh location to reset the away timer
  lastPingTime = Date.now()
  hideBanner('away')
  getLocation()
  showToast('Got it — refreshing your location', 'success')
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats/worker/' + currentWorker.id)
    const data = await res.json()
    if (data.stats) {
      document.getElementById('stat-sessions').textContent = data.stats.total_sessions || 0
      document.getElementById('stat-hours').textContent = (data.stats.total_hours || 0).toFixed(1)
      document.getElementById('stat-earnings').textContent = '$' + (data.stats.total_earnings || 0).toFixed(0)
    }
  } catch(e) {}
}

// ── Work Log grouped by Day ───────────────────────────────────────────────────
async function loadWorkLog() {
  try {
    const res = await fetch('/api/sessions/worker/' + currentWorker.id + '?limit=60')
    const data = await res.json()
    const el = document.getElementById('work-log-by-day')
    if (!data.sessions || data.sessions.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-sm text-center py-6"><i class="fas fa-inbox mb-2 block text-2xl"></i>No sessions yet</p>'
      return
    }

    // Group sessions by calendar date
    const groups = {}
    data.sessions.forEach(s => {
      const d = new Date(s.clock_in_time)
      const key = d.toISOString().split('T')[0]           // YYYY-MM-DD key
      if (!groups[key]) groups[key] = { date: d, sessions: [] }
      groups[key].sessions.push(s)
    })

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    el.innerHTML = Object.keys(groups).sort((a,b) => b.localeCompare(a)).map(key => {
      const g = groups[key]
      const dayLabel = key === today ? '📅 Today'
        : key === yesterday ? '📅 Yesterday'
        : '📅 ' + g.date.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' })

      const dayHours = g.sessions.reduce((sum, s) => sum + (s.total_hours || 0), 0)
      const dayEarnings = g.sessions.reduce((sum, s) => sum + (s.earnings || 0), 0)
      const hasActive = g.sessions.some(s => s.status === 'active')

      const sessionsHTML = g.sessions.map(s => {
        const clockIn = new Date(s.clock_in_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
        const clockOut = s.clock_out_time
          ? new Date(s.clock_out_time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
          : null
        const isActive = s.status === 'active'

        return \`<div class="bg-white border border-gray-100 rounded-xl p-3.5 mb-2 last:mb-0 shadow-sm">
          <!-- Job location + description -->
          \${s.job_location ? \`
            <div class="flex items-start gap-2 mb-2">
              <i class="fas fa-map-marker-alt text-red-500 mt-0.5 text-sm flex-shrink-0"></i>
              <div>
                <p class="text-sm font-bold text-gray-800">\${s.job_location}</p>
                \${s.job_description ? \`<p class="text-xs text-gray-500 mt-0.5">\${s.job_description}</p>\` : ''}
              </div>
            </div>
          \` : ''}
          <!-- Times + earnings -->
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-xs text-gray-500">
              <i class="fas fa-clock text-blue-400"></i>
              <span>\${clockIn}</span>
              <span class="text-gray-300">→</span>
              \${isActive
                ? \`<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium pulse">Working now</span>\`
                : \`<span>\${clockOut}</span>\`
              }
            </div>
            <div class="text-right">
              \${isActive
                ? \`<span class="text-green-600 text-xs font-medium">In progress...</span>\`
                : \`<span class="text-xs font-bold text-gray-700">\${(s.total_hours||0).toFixed(2)}h</span>
                   <span class="text-xs text-green-600 font-bold ml-1">$\${(s.earnings||0).toFixed(2)}</span>\`
              }
            </div>
          </div>
          \${s.clock_in_lat ? \`
            <div class="mt-1.5">
              <a href="https://maps.google.com/?q=\${s.clock_in_lat},\${s.clock_in_lng}" target="_blank"
                class="text-xs text-blue-500 hover:text-blue-700">
                <i class="fas fa-external-link-alt mr-1"></i>View on map
              </a>
            </div>
          \` : ''}
          \${!isActive ? \`
            <div class="mt-2 pt-2 border-t border-gray-100">
              <button onclick="openDisputeModal(\${s.id}, '\${(s.job_location||'').replace(/'/g,\\"\\\\\\\\'\\")}', '\${new Date(s.clock_in_time).toLocaleDateString()}')"
                class="text-xs text-rose-500 hover:text-rose-700 flex items-center gap-1">
                <i class="fas fa-flag mr-1"></i>Report an issue with this session
              </button>
            </div>
          \` : ''}
        </div>\`
      }).join('')

      return \`<div class="mb-4">
        <!-- Day header -->
        <div class="flex items-center justify-between mb-2 pl-1">
          <span class="text-sm font-bold text-gray-700">\${dayLabel}</span>
          <div class="flex items-center gap-2 text-xs">
            \${hasActive
              ? \`<span class="bg-green-100 text-green-700 px-2 py-0.5 rounded-full pulse font-medium">Active</span>\`
              : \`<span class="text-gray-500">\${dayHours.toFixed(1)}h</span>
                 <span class="font-bold text-green-600">$\${dayEarnings.toFixed(2)}</span>\`
            }
          </div>
        </div>
        <!-- Sessions for this day -->
        <div class="day-group pl-3">
          \${sessionsHTML}
        </div>
      </div>\`
    }).join('')
  } catch(e) { console.error(e) }
}

// ── Worker Calendar View ───────────────────────────────────────────────────────
let workerCalYear = new Date().getFullYear()
let workerCalMonth = new Date().getMonth() + 1
let workerCalHolidays = []
let workerCalSchedule = { work_days:[1,2,3,4,5] }
const WC_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function showWorkerView(v) {
  document.getElementById('view-log-panel').classList.toggle('hidden', v !== 'log')
  document.getElementById('view-cal-panel').classList.toggle('hidden', v !== 'calendar')
  document.getElementById('view-log-btn').className = v === 'log'
    ? 'px-3 py-1.5 text-xs font-medium rounded-xl bg-purple-600 text-white'
    : 'px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-100 text-gray-600'
  document.getElementById('view-cal-btn').className = v === 'calendar'
    ? 'px-3 py-1.5 text-xs font-medium rounded-xl bg-purple-600 text-white'
    : 'px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-100 text-gray-600'
  if (v === 'calendar') loadWorkerCalendar()
}

function workerCalPrev() { workerCalMonth--; if(workerCalMonth<1){workerCalMonth=12;workerCalYear--} loadWorkerCalendar() }
function workerCalNext() { workerCalMonth++; if(workerCalMonth>12){workerCalMonth=1;workerCalYear++} loadWorkerCalendar() }

async function loadWorkerCalendar() {
  if (!currentWorker) return
  document.getElementById('worker-cal-label').textContent = WC_MONTHS[workerCalMonth-1] + ' ' + workerCalYear
  try {
    const [calRes, holRes] = await Promise.all([
      fetch(\`/api/calendar/\${workerCalYear}/\${workerCalMonth}?worker_id=\${currentWorker.id}\`),
      fetch(\`/api/holidays/\${workerCalYear}\`)
    ])
    const calData = await calRes.json()
    const holData = await holRes.json()
    workerCalHolidays = holData.holidays || []
    workerCalSchedule = calData.settings || { work_days:[1,2,3,4,5] }
    renderWorkerCalGrid(calData)
    renderWorkerCalStats(calData)
    renderWorkerCalHolidays()
  } catch(e) { console.error(e) }
}

function renderWorkerCalGrid(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = workerCalSchedule.work_days || [1,2,3,4,5]
  const today = new Date().toISOString().split('T')[0]
  const holidayDates = {}
  workerCalHolidays.forEach(h => { holidayDates[h.date] = h })

  const firstDay = new Date(workerCalYear, workerCalMonth-1, 1).getDay()
  const daysInMonth = new Date(workerCalYear, workerCalMonth, 0).getDate()
  let html = ''

  for (let i = 0; i < firstDay; i++) {
    html += \`<div class="min-h-[44px] rounded-lg bg-gray-50"></div>\`
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = \`\${workerCalYear}-\${String(workerCalMonth).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`
    const dow = new Date(workerCalYear, workerCalMonth-1, d).getDay()
    const isWeekend = !workDays.includes(dow)
    const isToday = dateStr === today
    const isHoliday = !!holidayDates[dateStr]
    const sessions = sessionsByDate[dateStr] || []
    const hasSessions = sessions.length > 0
    const totalHours = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)

    let cellClass = 'min-h-[44px] rounded-lg p-1 text-center border text-xs '
    if (isToday)          cellClass += 'bg-yellow-100 border-yellow-400 ring-1 ring-yellow-300 '
    else if (isHoliday)   cellClass += 'bg-red-50 border-red-200 '
    else if (isWeekend)   cellClass += 'bg-gray-50 border-gray-100 '
    else if (hasSessions) cellClass += 'bg-green-50 border-green-300 '
    else                  cellClass += 'bg-white border-gray-100 '

    html += \`<div class="\${cellClass}">
      <div class="font-bold \${isToday?'text-yellow-700':isWeekend?'text-gray-300':isHoliday?'text-red-500':'text-gray-700'}">\${d}</div>
      \${isHoliday ? \`<div style="font-size:7px" class="text-red-400 leading-tight mt-0.5">★</div>\`
        : hasSessions ? \`<div style="font-size:8px" class="text-green-600 font-bold">\${totalHours.toFixed(1)}h</div>\`
        : isWeekend ? \`<div style="font-size:7px" class="text-gray-300">off</div>\` : ''}
    </div>\`
  }

  document.getElementById('worker-cal-grid').innerHTML = html
}

function renderWorkerCalStats(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  let totalHours = 0, totalEarnings = 0, daysWorked = 0
  Object.values(sessionsByDate).forEach((sessions) => {
    totalHours += sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
    totalEarnings += sessions.reduce((s, x) => s + (x.earnings || 0), 0)
    daysWorked++
  })
  document.getElementById('worker-cal-stats').innerHTML = \`
    <div class="bg-blue-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-blue-700">\${daysWorked}</p>
      <p class="text-xs text-blue-400">Days</p>
    </div>
    <div class="bg-green-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-green-700">\${totalHours.toFixed(1)}</p>
      <p class="text-xs text-green-400">Hours</p>
    </div>
    <div class="bg-purple-50 rounded-xl p-2.5 text-center">
      <p class="text-lg font-bold text-purple-700">$\${totalEarnings.toFixed(0)}</p>
      <p class="text-xs text-purple-400">Earned</p>
    </div>
  \`
}

function renderWorkerCalHolidays() {
  const monthHols = workerCalHolidays.filter(h => {
    const d = new Date(h.date)
    return d.getFullYear() === workerCalYear && d.getMonth()+1 === workerCalMonth
  })
  if (monthHols.length === 0) { document.getElementById('worker-cal-holidays').innerHTML = ''; return }
  document.getElementById('worker-cal-holidays').innerHTML = monthHols.map(h =>
    \`<div class="flex items-center justify-between text-xs py-1 border-t border-gray-100">
      <span class="text-red-600 font-medium"><i class="fas fa-star mr-1"></i>\${h.name}</span>
      <span class="text-amber-600 font-bold">\${h.stat_multiplier || 1.5}× pay</span>
    </div>\`
  ).join('')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('wt_device_id')
  if (!id) { id = 'dev_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now(); localStorage.setItem('wt_device_id', id) }
  return id
}

// ── Worker: Report Issue (Dispute) ───────────────────────────────────────────
let disputeSessionId = null

function openDisputeModal(sessionId, jobLocation, dateLabel) {
  disputeSessionId = sessionId
  document.getElementById('dispute-session-label').textContent =
    (jobLocation ? jobLocation + ' · ' : '') + (dateLabel || '')
  document.getElementById('dispute-message').value = ''
  document.getElementById('dispute-modal').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeDisputeModal() {
  document.getElementById('dispute-modal').classList.add('hidden')
  document.body.style.overflow = ''
  disputeSessionId = null
}

function setDisputeMsg(text) {
  document.getElementById('dispute-message').value = text
}

async function submitDispute() {
  const message = document.getElementById('dispute-message').value.trim()
  if (!message) { showToast('Please describe the issue', 'error'); return }
  if (!disputeSessionId || !currentWorker) return

  const btn = document.getElementById('dispute-submit-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Sending...'

  try {
    const res = await fetch('/api/disputes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: disputeSessionId,
        worker_id: currentWorker.id,
        message
      })
    })
    const data = await res.json()
    if (data.success) {
      closeDisputeModal()
      showToast('✅ Report sent to admin', 'success')
    } else {
      showToast(data.error || 'Failed to send report', 'error')
    }
  } catch(e) {
    showToast('Connection error — try again', 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
  }
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = \`fixed bottom-6 left-1/2 transform -translate-x-1/2 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white max-w-xs text-center
    \${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}\`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 4000)
}

// ── Add to Home Screen banner ────────────────────────────────────────────────
function dismissA2HS() {
  localStorage.setItem('a2hs_dismissed', '1')
  document.getElementById('a2hs-banner')?.remove()
}

;(function initA2HS() {
  if (localStorage.getItem('a2hs_dismissed')) return
  // Don't show if already installed (standalone mode)
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return
  const banner = document.getElementById('a2hs-banner')
  if (!banner) return
  const isAndroid = /android/i.test(navigator.userAgent)
  const isIOS     = /iphone|ipad|ipod/i.test(navigator.userAgent)
  if (!isIOS && !isAndroid) return   // desktop — don't show
  if (isAndroid) {
    banner.querySelector('.ios-hint')?.classList.add('hidden')
    banner.querySelector('.android-hint')?.classList.remove('hidden')
  }
  setTimeout(() => banner.classList.remove('hidden'), 2500)  // show after 2.5s
})()

// ── Feature 3: Worker Dispute / Report Issue ──────────────────────────────────
let disputeSessionId = null

function openDisputeModal(sessionId, jobLocation, dateStr) {
  disputeSessionId = sessionId
  const modal = document.getElementById('dispute-modal')
  document.getElementById('dispute-session-label').textContent =
    (jobLocation ? jobLocation + ' — ' : '') + dateStr
  document.getElementById('dispute-message').value = ''
  document.getElementById('dispute-send-btn').disabled = false
  document.getElementById('dispute-send-btn').innerHTML =
    '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
  modal.classList.remove('hidden')
  document.body.style.overflow = 'hidden'
  setTimeout(() => document.getElementById('dispute-message').focus(), 200)
}

function closeDisputeModal() {
  document.getElementById('dispute-modal').classList.add('hidden')
  document.body.style.overflow = ''
  disputeSessionId = null
}

async function sendDispute() {
  const message = document.getElementById('dispute-message').value.trim()
  if (!message) { showToast('Please describe the issue', 'error'); return }
  if (!disputeSessionId || !currentWorker) return

  const btn = document.getElementById('dispute-send-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Sending...'

  try {
    const res = await fetch('/api/disputes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: disputeSessionId,
        worker_id: currentWorker.id,
        message
      })
    })
    const data = await res.json()
    if (data.success) {
      closeDisputeModal()
      showToast('Your report was sent to admin', 'success')
    } else {
      showToast(data.error || 'Failed to send report', 'error')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
    }
  } catch(e) {
    showToast('Connection error', 'error')
    btn.disabled = false
    btn.innerHTML = '<i class="fas fa-paper-plane mr-1.5"></i>Send Report'
  }
}

const DISPUTE_MSGS = [
  '',
  'I was auto clocked out but I was still working',
  'The clock-out time is wrong. I worked longer than recorded',
  'GPS showed wrong location. I was at the job site the whole time',
  'Hours or earnings look incorrect'
]
function setDisputeMsg(n) {
  document.getElementById('dispute-message').value = DISPUTE_MSGS[n] || ''
}

</script>

<!-- ── Worker Dispute Modal ─────────────────────────────────────────────────── -->
<div id="dispute-modal" class="hidden fixed inset-0 bg-black/70 z-50 flex items-end justify-center p-4" onclick="if(event.target===this)closeDisputeModal()">
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
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
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
</head>
<body class="bg-gray-100 min-h-screen">

<!-- Admin Login -->
<div id="admin-login" class="min-h-screen flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm">
    <div class="text-center mb-6">
      <div class="w-16 h-16 bg-indigo-600 rounded-full flex items-center justify-center mx-auto mb-4">
        <i class="fas fa-shield-alt text-white text-2xl"></i>
      </div>
      <h2 class="text-2xl font-bold text-gray-800">Admin Panel</h2>
      <p class="text-gray-500 text-sm">ClockInProof Dashboard</p>
    </div>
    <div class="space-y-4">
      <input id="admin-pin-input" type="password" placeholder="Admin PIN" maxlength="6"
        class="w-full px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      <button onclick="adminLogin()"
        class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl">
        <i class="fas fa-unlock mr-2"></i>Access Dashboard
      </button>
    </div>
    <div id="admin-login-error" class="hidden mt-3 text-red-500 text-sm text-center"></div>
    <p class="text-center text-xs text-gray-400 mt-4">Default PIN: 1234</p>
  </div>
</div>

<!-- Admin Dashboard -->
<div id="admin-dashboard" class="hidden min-h-screen bg-gray-100 flex flex-col">

  <!-- ── Top Navbar ─────────────────────────────────────────────────────────── -->
  <div class="bg-indigo-700 text-white shadow-lg flex-shrink-0">
    <div class="px-4 py-3 flex items-center justify-between">
      <!-- Left: hamburger + logo -->
      <div class="flex items-center gap-3">
        <button onclick="toggleSidebar()" class="w-9 h-9 flex items-center justify-center rounded-xl hover:bg-indigo-600 transition-colors lg:hidden" id="sidebar-hamburger">
          <i class="fas fa-bars text-lg"></i>
        </button>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-white bg-opacity-20 rounded-lg flex items-center justify-center">
            <i class="fas fa-clock text-sm"></i>
          </div>
          <div>
            <h1 class="text-base font-bold leading-tight">ClockInProof</h1>
            <p class="text-indigo-300 text-[10px] leading-tight" id="admin-last-updated"></p>
          </div>
        </div>
      </div>
      <!-- Right: stat pills + actions -->
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

        <button onclick="showTab('workers')" data-tab="workers"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-blue-100 text-blue-600 flex-shrink-0">
            <i class="fas fa-users text-sm"></i>
          </span>
          <span>Workers</span>
          <span class="ml-auto text-xs text-gray-400" id="stat-total-workers">–</span>
        </button>

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
            <i class="fas fa-paper-plane text-sm"></i>
          </span>
          <span>Weekly Summary</span>
          <span class="ml-auto text-[10px] text-amber-600 font-bold bg-amber-50 px-1.5 py-0.5 rounded-full">Acct</span>
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

        <button onclick="showTab('disputes')" data-tab="disputes"
          class="tab-btn sidebar-btn w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-indigo-50 hover:text-indigo-700 transition-colors">
          <span class="w-8 h-8 flex items-center justify-center rounded-lg bg-rose-100 text-rose-600 flex-shrink-0">
            <i class="fas fa-flag text-sm"></i>
          </span>
          <span>Issue Reports</span>
          <span id="disputes-badge" class="hidden ml-auto bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"></span>
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
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-gray-700">All Workers</h3>
        <button onclick="showAddWorkerModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-4 py-2 rounded-xl font-medium">
          <i class="fas fa-plus mr-1"></i>Add Worker
        </button>
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
            <th class="py-3"></th>
          </tr></thead>
          <tbody id="workers-tbody">
            <tr><td colspan="7" class="text-center py-8 text-gray-400">Loading...</td></tr>
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
        <h3 class="font-bold text-gray-700">Worker Locations</h3>
        <button onclick="loadMap()" class="text-indigo-600 text-sm font-medium hover:text-indigo-700">
          <i class="fas fa-sync-alt mr-1"></i>Refresh Map
        </button>
      </div>
      <div id="admin-map" class="rounded-xl overflow-hidden"></div>
      <p class="text-xs text-gray-400 mt-2">Shows clock-in locations for today's sessions</p>
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
      <h3 class="font-bold text-gray-700 mb-5 flex items-center gap-2">
        <i class="fas fa-cog text-indigo-500"></i> App Settings
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">

        <!-- General -->
        <div class="space-y-4">
          <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2">General</h4>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">App Name</label>
            <input id="s-app-name" type="text" class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"/>
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

      <!-- Override Notifications -->
      <div class="space-y-4">
        <h4 class="font-semibold text-gray-600 text-sm uppercase tracking-wider border-b pb-2 flex items-center gap-2">
          <i class="fas fa-bell text-amber-500"></i> Override Notifications
          <span class="text-xs font-normal text-gray-400 normal-case tracking-normal">Get alerted the moment a worker is blocked</span>
        </h4>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Email notification -->
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
            <p class="text-xs text-gray-500 mb-2">Sends a rich HTML email with map link, worker details, and a direct approval link.</p>
            <p class="text-xs text-green-600 font-medium"><i class="fas fa-check-circle mr-1"></i>Uses Resend (already configured for weekly reports)</p>
          </div>

          <!-- SMS notification -->
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
            <p class="text-xs text-gray-500 mb-2">Sends an SMS with a deep-link to the Overrides tab. Works on Android &amp; iOS.</p>
            <p class="text-xs text-amber-600 font-medium"><i class="fas fa-exclamation-circle mr-1"></i>Requires Twilio credentials (see below)</p>
          </div>
        </div>

        <!-- Admin phone number -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            Admin Phone Number <span class="text-gray-400 font-normal">(for SMS — include country code e.g. +1 613 555 0100)</span>
          </label>
          <input id="s-admin-phone" type="tel" placeholder="+1 613 555 0100"
            class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 text-sm"/>
        </div>

        <!-- Twilio credentials (collapsible) -->
        <details class="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden">
          <summary class="flex items-center gap-2 cursor-pointer px-4 py-3 font-medium text-sm text-gray-700 hover:bg-gray-100">
            <i class="fas fa-key text-gray-400"></i> Twilio SMS Setup
            <span class="text-xs text-gray-400 font-normal ml-auto">Free trial gives ~1000 texts</span>
          </summary>
          <div class="px-4 pb-4 space-y-3 border-t border-gray-200 pt-3">
            <div class="bg-blue-50 rounded-xl p-3 text-xs text-blue-700 mb-3">
              <strong>Setup in 3 steps:</strong>
              <ol class="list-decimal list-inside mt-1 space-y-1">
                <li>Sign up free at <a href="https://twilio.com" target="_blank" class="underline">twilio.com</a> — get $15 credit (~1000 SMS)</li>
                <li>Copy your Account SID, Auth Token, and free phone number from the Twilio Console</li>
                <li>In production: add <code class="bg-white px-1 rounded">TWILIO_ACCOUNT_SID</code>, <code class="bg-white px-1 rounded">TWILIO_AUTH_TOKEN</code>, <code class="bg-white px-1 rounded">TWILIO_FROM_NUMBER</code> as Cloudflare secrets — or enter them below for local dev</li>
              </ol>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">Account SID</label>
              <input id="s-twilio-sid" type="text" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                class="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">Auth Token</label>
              <input id="s-twilio-token" type="password" placeholder="Your Twilio Auth Token"
                class="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">From Number (Twilio number)</label>
              <input id="s-twilio-from" type="tel" placeholder="+15005550006"
                class="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-400"/>
            </div>
            <p class="text-xs text-gray-400">Note: For production deployment, use Cloudflare secrets instead of saving here for security.</p>
          </div>
        </details>

        <!-- App Host URL -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            App URL <span class="text-gray-400 font-normal">(used in notification deep-links — e.g. https://yourapp.pages.dev)</span>
          </label>
          <input id="s-app-host" type="url" placeholder="https://yourapp.pages.dev"
            class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400 text-sm"/>
          <p class="text-xs text-gray-400 mt-1">When you tap the notification link, it opens this URL + /admin#overrides directly.</p>
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
            <i class="fas fa-paper-plane text-amber-500"></i> Weekly Summary to Accountant
          </h3>
          <p class="text-sm text-gray-400 mt-0.5">Send a clean per-worker recap of hours &amp; earnings for any week</p>
        </div>
      </div>

      <!-- Week selector -->
      <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 mb-5">
        <div class="flex items-center gap-4 flex-wrap">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Select Week</label>
            <input type="date" id="acct-week-date"
              class="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
          </div>
          <div class="flex-1">
            <label class="block text-xs font-semibold text-gray-600 mb-1">Week Range</label>
            <p id="acct-week-label" class="text-sm font-bold text-amber-700 py-2">—</p>
          </div>
        </div>
        <div class="flex gap-2 mt-3 flex-wrap">
          <button onclick="setAcctWeek(-1)" class="px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-xl text-xs font-medium hover:bg-gray-50">
            <i class="fas fa-chevron-left mr-1"></i>Prev Week
          </button>
          <button onclick="setAcctWeek(0)" class="px-3 py-2 bg-amber-500 text-white rounded-xl text-xs font-medium hover:bg-amber-600">
            <i class="fas fa-calendar-check mr-1"></i>This Week
          </button>
          <button onclick="setAcctWeek(1)" class="px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-xl text-xs font-medium hover:bg-gray-50">
            Next Week<i class="fas fa-chevron-right ml-1"></i>
          </button>
          <button onclick="loadAcctPreview()" class="ml-auto px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-semibold border border-indigo-200">
            <i class="fas fa-eye mr-1"></i>Preview Recap
          </button>
        </div>
      </div>

      <!-- Accountant email field -->
      <div class="bg-white border border-gray-200 rounded-2xl p-5 mb-5">
        <label class="block text-sm font-semibold text-gray-700 mb-1">
          <i class="fas fa-envelope text-amber-500 mr-1"></i> Send To (Accountant Email)
        </label>
        <div class="flex gap-2">
          <input id="acct-email" type="email" placeholder="accountant@yourfirm.com"
            class="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"/>
          <button onclick="sendAcctSummary()" id="acct-send-btn"
            class="bg-amber-500 hover:bg-amber-600 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-colors shadow-md shadow-amber-200 flex items-center gap-2">
            <i class="fas fa-paper-plane"></i> Send
          </button>
        </div>
        <p class="text-xs text-gray-400 mt-2">Also CC'd to admin email. Uses Resend (free tier).</p>
      </div>

      <!-- Per-worker preview -->
      <div id="acct-preview" class="space-y-3">
        <div class="text-center py-8 text-gray-400">
          <i class="fas fa-users text-3xl mb-3 block text-gray-300"></i>
          <p class="text-sm">Select a week above and click <strong>Preview Recap</strong> to see the summary</p>
        </div>
      </div>

      <div id="acct-send-status" class="hidden mt-4 rounded-xl p-4 text-sm"></div>
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

    </main><!-- /main content -->
  </div><!-- /flex body -->
</div><!-- /admin-dashboard -->

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
        <input id="site-address" type="text" placeholder="Full street address for GPS matching"
          class="w-full px-3 py-2.5 border rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-sm"/>
        <p class="text-xs text-gray-400 mt-1">Be specific — this address is used for GPS geofence matching.</p>
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
<div id="add-worker-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
    <div class="flex items-center justify-between mb-5">
      <h3 class="text-lg font-bold text-gray-800">Add New Worker</h3>
      <button onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
    </div>
    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
        <input id="modal-name" type="text" placeholder="Worker name"
          class="w-full px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Phone Number *</label>
        <input id="modal-phone" type="tel" placeholder="+1 234 567 8900"
          class="w-full px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Hourly Rate ($/hr)</label>
        <input id="modal-rate" type="number" placeholder="15.00" step="0.50"
          class="w-full px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">PIN (4 digits)</label>
        <input id="modal-pin" type="text" placeholder="0000" maxlength="4"
          class="w-full px-4 py-3 border rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
      </div>
      <div class="flex gap-3 pt-2">
        <button onclick="closeModal()" class="flex-1 border border-gray-300 text-gray-700 font-medium py-3 rounded-xl hover:bg-gray-50">Cancel</button>
        <button onclick="addWorker()" class="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-xl">Add Worker</button>
      </div>
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
      <button id="wd-filter-sessions-btn" onclick="filterSessionsByWorker()" class="ml-auto text-xs text-indigo-600 hover:text-indigo-800 font-medium">
        <i class="fas fa-filter mr-1"></i>Filter Sessions Tab
      </button>
    </div>
    <!-- Force Clock-Out Action Bar (shown when worker is active) -->
    <div id="wd-action-bar" class="hidden px-5 py-3 border-b bg-red-50"></div>
    <!-- Sessions list -->
    <div class="px-5 py-4 flex-1">
      <h4 class="text-sm font-semibold text-gray-600 mb-3 flex items-center gap-2">
        <i class="fas fa-history text-gray-400"></i> Recent Sessions
      </h4>
      <div id="wd-sessions" class="space-y-3">
        <p class="text-gray-400 text-sm text-center py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Loading...</p>
      </div>
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
      <!-- Reason input -->
      <div>
        <label class="text-xs font-semibold text-gray-600 block mb-1.5">
          <i class="fas fa-comment-alt mr-1 text-gray-400"></i>Reason / Note <span class="text-gray-400 font-normal">(optional)</span>
        </label>
        <textarea id="aco-note" rows="2" placeholder="e.g. Worker left site, No-show after 2h, End of day..."
          class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"></textarea>
        <!-- Quick reasons -->
        <div class="flex flex-wrap gap-1.5 mt-2">
          <button onclick="setVal('aco-note','Worker left the job site')" class="text-xs bg-orange-50 text-orange-600 border border-orange-200 px-2 py-1 rounded-lg hover:bg-orange-100">Left site</button>
          <button onclick="setVal('aco-note','Worker forgot to clock out')" class="text-xs bg-yellow-50 text-yellow-600 border border-yellow-200 px-2 py-1 rounded-lg hover:bg-yellow-100">Forgot to clock out</button>
          <button onclick="setVal('aco-note','No GPS signal — admin action')" class="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2 py-1 rounded-lg hover:bg-blue-100">No GPS</button>
          <button onclick="setVal('aco-note','End of work day')" class="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-2 py-1 rounded-lg hover:bg-gray-200">End of day</button>
        </div>
      </div>
      <!-- Action buttons -->
      <div class="flex gap-3 pt-1">
        <button onclick="closeAdminClockoutModal()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition-colors">
          Cancel
        </button>
        <button id="aco-confirm-btn" onclick="confirmAdminClockout()" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-red-200">
          <i class="fas fa-stop-circle mr-1.5"></i>Clock Out Now
        </button>
      </div>
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

<script src="/static/admin.js"></script>

</body>
</html>`
}

// ─── CLOUDFLARE SCHEDULED TRIGGER ────────────────────────────────────────────
// Fires every Friday at 23:59 UTC  →  cron: "59 23 * * 5"
export default {
  fetch: app.fetch,
  async scheduled(_event: any, env: any, _ctx: any) {
    await runWeeklyEmailJob(env.DB as D1Database, env)
  }
}

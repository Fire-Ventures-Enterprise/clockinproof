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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (worker_id) REFERENCES workers(id)
    )`,
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
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('app_name', 'WorkTracker')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('default_hourly_rate', '15.00')`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_pin', '1234')`,
  ]
  for (const sql of statements) {
    await db.prepare(sql).run()
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

// Clock In
app.post('/api/sessions/clock-in', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const { worker_id, latitude, longitude, address, notes, job_location, job_description } = await c.req.json()

  if (!worker_id) return c.json({ error: 'worker_id required' }, 400)
  if (!job_location || !job_location.trim()) return c.json({ error: 'Job location is required' }, 400)
  if (!job_description || !job_description.trim()) return c.json({ error: 'Job description is required' }, 400)

  // Check if already clocked in
  const active = await db.prepare(
    "SELECT * FROM sessions WHERE worker_id = ? AND status = 'active'"
  ).bind(worker_id).first()

  if (active) {
    return c.json({ error: 'Already clocked in', session: active }, 409)
  }

  const now = new Date().toISOString()
  const result = await db.prepare(
    `INSERT INTO sessions 
     (worker_id, clock_in_time, clock_in_lat, clock_in_lng, clock_in_address, notes, job_location, job_description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).bind(worker_id, now, latitude || null, longitude || null, address || null, notes || null, job_location.trim(), job_description.trim()).run()

  const session = await db.prepare(
    'SELECT * FROM sessions WHERE id = ?'
  ).bind(result.meta.last_row_id).first()

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
  const db = c.env.DB
  const { session_id, worker_id, latitude, longitude, accuracy } = await c.req.json()

  if (!session_id || !worker_id || !latitude || !longitude) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  await db.prepare(
    `INSERT INTO location_pings (session_id, worker_id, latitude, longitude, accuracy)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(session_id, worker_id, latitude, longitude, accuracy || null).run()

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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0"/>
  <meta name="theme-color" content="#1e40af"/>
  <title>WorkTracker — Clock In/Out</title>
  <link rel="manifest" href="/static/manifest.json"/>
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

<!-- Register Screen -->
<div id="screen-register" class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm slide-up">
    <div class="text-center mb-8">
      <div class="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
        <i class="fas fa-clock text-white text-3xl"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">WorkTracker</h1>
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

    <!-- GPS Location Card -->
    <div class="bg-white rounded-2xl shadow-sm p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-gray-700 flex items-center gap-2">
          <i class="fas fa-map-marker-alt text-red-500"></i> Current Location
        </h3>
        <button onclick="getLocation()" class="text-blue-600 text-sm font-medium hover:text-blue-700">
          <i class="fas fa-sync-alt mr-1"></i>Refresh
        </button>
      </div>
      <div id="location-status" class="text-sm text-gray-500 mb-3">
        <i class="fas fa-circle-notch spinner mr-1"></i> Getting location...
      </div>
      <div id="map" class="hidden"></div>
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
      <h3 class="font-semibold text-gray-700 mb-4 flex items-center gap-2">
        <i class="fas fa-calendar-alt text-purple-500"></i> Work Log
      </h3>
      <div id="work-log-by-day" class="space-y-4">
        <p class="text-gray-400 text-sm text-center py-4">No sessions yet</p>
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
  setTimeout(() => document.getElementById('job-location-input').focus(), 300)
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
  box.innerHTML = filtered.map(l =>
    \`<button onclick="selectLocation('\${l.replace(/'/g,"&#39;")}')"
      class="w-full text-left px-4 py-3 hover:bg-blue-50 text-sm text-gray-700 border-b border-gray-100 last:border-0">
      <i class="fas fa-history text-gray-400 mr-2 text-xs"></i>\${l}
    </button>\`
  ).join('')
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
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch spinner mr-2"></i>Clocking in...'

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
      showToast('Clocked in! Have a great shift 💪', 'success')
      await loadStats()
      await loadWorkLog()
    } else {
      showToast(data.error || 'Failed to clock in', 'error')
    }
  } catch(e) { showToast('Connection error', 'error') }

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-play-circle mr-2"></i>Start Working'
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
  const mapEl = document.getElementById('map')
  mapEl.classList.remove('hidden')
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map)
  }
  map.setView([lat, lng], 16)
  if (marker) marker.remove()
  marker = L.circleMarker([lat, lng], { color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.8, radius: 10 }).addTo(map)
}

function startPingInterval() {
  clearInterval(pingInterval)
  pingInterval = setInterval(async () => {
    if (!activeSession || !currentLat) return
    try {
      await fetch('/api/location/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeSession.id, worker_id: currentWorker.id, latitude: currentLat, longitude: currentLng })
      })
      getLocation()
    } catch(e) {}
  }, 5 * 60 * 1000)
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('wt_device_id')
  if (!id) { id = 'dev_' + Math.random().toString(36).substr(2, 12) + '_' + Date.now(); localStorage.setItem('wt_device_id', id) }
  return id
}

function showToast(msg, type = 'info') {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = \`fixed bottom-6 left-1/2 transform -translate-x-1/2 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white max-w-xs text-center
    \${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}\`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 4000)
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
  <title>WorkTracker — Admin Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; }
    #admin-map { height: 400px; }
    .tab-active { border-bottom: 3px solid #2563eb; color: #2563eb; }
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
      <p class="text-gray-500 text-sm">WorkTracker Dashboard</p>
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
<div id="admin-dashboard" class="hidden">
  <!-- Header -->
  <div class="bg-indigo-700 text-white shadow-lg">
    <div class="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <i class="fas fa-clock text-2xl"></i>
        <div>
          <h1 class="text-xl font-bold">WorkTracker Admin</h1>
          <p class="text-indigo-300 text-xs" id="admin-last-updated"></p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="refreshAll()" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-sm font-medium">
          <i class="fas fa-sync-alt mr-1"></i>Refresh
        </button>
        <button onclick="adminLogout()" class="bg-indigo-800 hover:bg-indigo-900 px-4 py-2 rounded-xl text-sm font-medium">
          <i class="fas fa-sign-out-alt mr-1"></i>Logout
        </button>
      </div>
    </div>
  </div>

  <!-- Stats Row -->
  <div class="max-w-7xl mx-auto px-4 py-6">
    <!-- Period Selector -->
    <div class="flex gap-2 mb-6">
      <button onclick="changePeriod('today')" class="period-btn px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white" data-period="today">Today</button>
      <button onclick="changePeriod('week')" class="period-btn px-4 py-2 rounded-xl text-sm font-medium bg-white text-gray-600 shadow-sm" data-period="week">This Week</button>
      <button onclick="changePeriod('month')" class="period-btn px-4 py-2 rounded-xl text-sm font-medium bg-white text-gray-600 shadow-sm" data-period="month">This Month</button>
      <button onclick="changePeriod('all')" class="period-btn px-4 py-2 rounded-xl text-sm font-medium bg-white text-gray-600 shadow-sm" data-period="all">All Time</button>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-users text-blue-600"></i>
          </div>
          <span class="text-gray-500 text-sm">Total Workers</span>
        </div>
        <p class="text-3xl font-bold text-gray-800" id="stat-total-workers">–</p>
      </div>
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-user-clock text-green-600"></i>
          </div>
          <span class="text-gray-500 text-sm">Working Now</span>
        </div>
        <p class="text-3xl font-bold text-green-600" id="stat-working-now">–</p>
      </div>
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-clock text-yellow-600"></i>
          </div>
          <span class="text-gray-500 text-sm">Total Hours</span>
        </div>
        <p class="text-3xl font-bold text-gray-800" id="stat-total-hours">–</p>
      </div>
      <div class="bg-white rounded-2xl shadow-sm p-5">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-dollar-sign text-purple-600"></i>
          </div>
          <span class="text-gray-500 text-sm">Total Payroll</span>
        </div>
        <p class="text-3xl font-bold text-gray-800" id="stat-total-payroll">–</p>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-0 border-b border-gray-200 mb-6 bg-white rounded-t-2xl px-2">
      <button onclick="showTab('live')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600 tab-active" data-tab="live">
        <i class="fas fa-satellite-dish mr-1"></i>Live View
      </button>
      <button onclick="showTab('workers')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600" data-tab="workers">
        <i class="fas fa-users mr-1"></i>Workers
      </button>
      <button onclick="showTab('sessions')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600" data-tab="sessions">
        <i class="fas fa-list mr-1"></i>Sessions
      </button>
      <button onclick="showTab('map')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600" data-tab="map">
        <i class="fas fa-map mr-1"></i>Map
      </button>
    </div>

    <!-- Tab: Live -->
    <div id="tab-live" class="tab-content bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
      <h3 class="font-bold text-gray-700 mb-4 flex items-center gap-2">
        <span class="w-2 h-2 bg-green-500 rounded-full pulse"></span>
        Currently Working Workers
      </h3>
      <div id="live-workers" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <p class="text-gray-400 text-center py-8 col-span-full">No workers currently clocked in</p>
      </div>
    </div>

    <!-- Tab: Workers -->
    <div id="tab-workers" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
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
    <div id="tab-sessions" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
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
    <div id="tab-map" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-gray-700">Worker Locations</h3>
        <button onclick="loadMap()" class="text-indigo-600 text-sm font-medium hover:text-indigo-700">
          <i class="fas fa-sync-alt mr-1"></i>Refresh Map
        </button>
      </div>
      <div id="admin-map" class="rounded-xl overflow-hidden"></div>
      <p class="text-xs text-gray-400 mt-2">Shows clock-in locations for today's sessions</p>
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

<script>
let adminMap = null
let currentPeriod = 'today'
let allSessionsData = []

// ── Admin Login ───────────────────────────────────────────────────────────────
async function adminLogin() {
  const pin = document.getElementById('admin-pin-input').value.trim()
  
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const adminPin = data.settings?.admin_pin || '1234'
    
    if (pin === adminPin) {
      document.getElementById('admin-login').classList.add('hidden')
      document.getElementById('admin-dashboard').classList.remove('hidden')
      await refreshAll()
      setInterval(refreshAll, 60000) // Auto-refresh every minute
    } else {
      document.getElementById('admin-login-error').textContent = 'Incorrect PIN. Try again.'
      document.getElementById('admin-login-error').classList.remove('hidden')
    }
  } catch(e) {
    // Fallback PIN check
    if (pin === '1234') {
      document.getElementById('admin-login').classList.add('hidden')
      document.getElementById('admin-dashboard').classList.remove('hidden')
      await refreshAll()
    }
  }
}

function adminLogout() {
  document.getElementById('admin-login').classList.remove('hidden')
  document.getElementById('admin-dashboard').classList.add('hidden')
  document.getElementById('admin-pin-input').value = ''
}

document.getElementById('admin-pin-input').addEventListener('keyup', e => {
  if (e.key === 'Enter') adminLogin()
})

// ── Data Loading ──────────────────────────────────────────────────────────────
async function refreshAll() {
  document.getElementById('admin-last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString()
  await Promise.all([loadStats(), loadLive(), loadWorkers(), loadSessions()])
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats/summary?period=' + currentPeriod)
    const data = await res.json()
    const s = data.stats
    document.getElementById('stat-total-workers').textContent = s.total_workers || 0
    document.getElementById('stat-working-now').textContent = s.currently_working || 0
    document.getElementById('stat-total-hours').textContent = (s.total_hours || 0).toFixed(1) + 'h'
    document.getElementById('stat-total-payroll').textContent = '$' + (s.total_earnings || 0).toFixed(2)
  } catch(e) { console.error(e) }
}

async function loadLive() {
  try {
    const res = await fetch('/api/sessions/active')
    const data = await res.json()
    const el = document.getElementById('live-workers')
    
    if (!data.sessions || data.sessions.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-center py-8 col-span-full"><i class="fas fa-moon mr-2"></i>No workers currently clocked in</p>'
      return
    }
    
    el.innerHTML = data.sessions.map(s => {
      const start = new Date(s.clock_in_time)
      const now = new Date()
      const hoursWorked = ((now - start) / 3600000).toFixed(1)
      const estimatedEarnings = (parseFloat(hoursWorked) * (s.hourly_rate || 0)).toFixed(2)
      const hasLocation = s.clock_in_lat && s.clock_in_lng
      
      return \`<div class="border border-gray-100 rounded-xl p-4 hover:shadow-md transition-shadow">
        <div class="flex items-start justify-between mb-3">
          <div>
            <h4 class="font-bold text-gray-800">\${s.worker_name}</h4>
            <p class="text-gray-500 text-xs">\${s.worker_phone}</p>
          </div>
          <span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full font-medium pulse">
            <i class="fas fa-circle mr-1" style="font-size:6px"></i>LIVE
          </span>
        </div>
        <div class="grid grid-cols-2 gap-2 mb-3">
          <div class="bg-blue-50 rounded-lg p-2 text-center">
            <p class="text-xs text-blue-500">Clock In</p>
            <p class="text-sm font-bold text-blue-700">\${start.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</p>
          </div>
          <div class="bg-yellow-50 rounded-lg p-2 text-center">
            <p class="text-xs text-yellow-500">Hours</p>
            <p class="text-sm font-bold text-yellow-700">\${hoursWorked}h</p>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs">
          <span class="text-gray-500">
            \${hasLocation ? \`<i class="fas fa-map-marker-alt text-red-500 mr-1"></i>GPS tracked\` : '<i class="fas fa-map-marker-slash text-gray-400 mr-1"></i>No GPS'}
          </span>
          <span class="font-bold text-purple-600">~$\${estimatedEarnings}</span>
        </div>
      </div>\`
    }).join('')
  } catch(e) { console.error(e) }
}

async function loadWorkers() {
  try {
    const res = await fetch('/api/workers')
    const data = await res.json()
    const tbody = document.getElementById('workers-tbody')

    // Populate the worker filter dropdown
    const workerSelect = document.getElementById('filter-worker')
    if (workerSelect && data.workers) {
      const currentVal = workerSelect.value
      workerSelect.innerHTML = '<option value="">All Workers</option>' +
        data.workers.map(w => \`<option value="\${w.id}" \${currentVal == w.id ? 'selected' : ''}>\${w.name}</option>\`).join('')
    }

    if (!data.workers || data.workers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-gray-400">No workers registered</td></tr>'
      return
    }
    
    tbody.innerHTML = data.workers.map(w => {
      const status = w.currently_clocked_in > 0
        ? '<span class="bg-green-100 text-green-700 text-xs px-2 py-1 rounded-full pulse">Working</span>'
        : w.active
          ? '<span class="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full">Inactive</span>'
          : '<span class="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-full">Disabled</span>'
      
      return \`<tr class="border-b border-gray-50 hover:bg-gray-50">
        <td class="py-3 font-medium text-gray-800">\${w.name}</td>
        <td class="py-3 text-gray-500">\${w.phone}</td>
        <td class="py-3 text-right font-medium text-green-600">$\${(w.hourly_rate||0).toFixed(2)}</td>
        <td class="py-3 text-right text-gray-700">\${(w.total_hours_all_time||0).toFixed(1)}h</td>
        <td class="py-3 text-right font-bold text-gray-800">$\${(w.total_earnings_all_time||0).toFixed(2)}</td>
        <td class="py-3 text-center">\${status}</td>
        <td class="py-3 text-right">
          <button onclick="editWorkerRate(\${w.id}, '\${w.name}', \${w.hourly_rate})" class="text-indigo-600 hover:text-indigo-800 text-xs mr-2">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="deleteWorker(\${w.id}, '\${w.name}')" class="text-red-500 hover:text-red-700 text-xs">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      </tr>\`
    }).join('')
  } catch(e) { console.error(e) }
}

async function loadSessions() {
  try {
    const date = document.getElementById('filter-date').value
    const workerId = document.getElementById('filter-worker').value
    let url = '/api/sessions?limit=200'
    if (date) url += '&date=' + date
    if (workerId) url += '&worker_id=' + workerId

    const res = await fetch(url)
    const data = await res.json()
    allSessionsData = data.sessions || []
    const container = document.getElementById('sessions-by-day')

    if (allSessionsData.length === 0) {
      container.innerHTML = \`<div class="text-center py-12 text-gray-400">
        <i class="fas fa-calendar-times text-4xl mb-3 block"></i>
        <p>No sessions found for this filter</p>
      </div>\`
      return
    }

    // Group by day
    const groups = {}
    allSessionsData.forEach(s => {
      const key = new Date(s.clock_in_time).toISOString().split('T')[0]
      if (!groups[key]) groups[key] = []
      groups[key].push(s)
    })

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    container.innerHTML = Object.keys(groups).sort((a,b) => b.localeCompare(a)).map(key => {
      const sessions = groups[key]
      const d = new Date(key + 'T12:00:00')
      const dayLabel = key === today ? 'Today'
        : key === yesterday ? 'Yesterday'
        : d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' })

      const dayHours = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
      const dayEarnings = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
      const hasActive = sessions.some(s => s.status === 'active')
      const uniqueWorkers = [...new Set(sessions.map(s => s.worker_name))].filter(Boolean)

      const sessionsHTML = sessions.map(s => {
        const clockIn = new Date(s.clock_in_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
        const clockOut = s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : null
        const isActive = s.status === 'active'
        const mapLink = s.clock_in_lat
          ? \`<a href="https://maps.google.com/?q=\${s.clock_in_lat},\${s.clock_in_lng}" target="_blank" class="text-blue-500 hover:text-blue-700 text-xs ml-2"><i class="fas fa-map-marker-alt mr-0.5"></i>Map</a>\`
          : ''

        return \`<div class="bg-gray-50 rounded-xl p-4 border border-gray-100 hover:border-indigo-200 hover:shadow-sm transition-all">
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1">
              <!-- Worker name -->
              <div class="flex items-center gap-2 mb-2">
                <div class="w-7 h-7 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <i class="fas fa-user text-indigo-500 text-xs"></i>
                </div>
                <span class="font-bold text-gray-800 text-sm">\${s.worker_name || '–'}</span>
                <span class="text-gray-400 text-xs">\${s.worker_phone || ''}</span>
                \${isActive ? \`<span class="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium pulse ml-auto">● LIVE</span>\` : ''}
              </div>
              <!-- Job location -->
              \${s.job_location ? \`
                <div class="flex items-start gap-1.5 mb-1.5 ml-9">
                  <i class="fas fa-map-marker-alt text-red-500 mt-0.5 text-xs flex-shrink-0"></i>
                  <p class="text-sm font-semibold text-gray-700">\${s.job_location}</p>
                </div>
              \` : ''}
              <!-- Job description -->
              \${s.job_description ? \`
                <div class="flex items-start gap-1.5 mb-2 ml-9">
                  <i class="fas fa-tools text-blue-400 mt-0.5 text-xs flex-shrink-0"></i>
                  <p class="text-xs text-gray-500">\${s.job_description}</p>
                </div>
              \` : ''}
              <!-- Time row -->
              <div class="flex items-center gap-3 ml-9 text-xs text-gray-500">
                <span><i class="fas fa-sign-in-alt text-green-500 mr-1"></i>\${clockIn}</span>
                <span class="text-gray-300">→</span>
                \${isActive
                  ? \`<span class="text-green-600 font-medium">Still working...</span>\`
                  : \`<span><i class="fas fa-sign-out-alt text-red-400 mr-1"></i>\${clockOut}</span>\`
                }
                \${mapLink}
              </div>
            </div>
            <!-- Earnings block -->
            <div class="text-right flex-shrink-0">
              \${isActive
                ? \`<span class="text-green-500 text-xs font-medium">In progress</span>\`
                : \`<p class="text-base font-bold text-gray-800">\${(s.total_hours||0).toFixed(2)}h</p>
                   <p class="text-sm font-bold text-green-600">$\${(s.earnings||0).toFixed(2)}</p>\`
              }
            </div>
          </div>
        </div>\`
      }).join('')

      return \`<div class="border border-gray-200 rounded-2xl overflow-hidden">
        <!-- Day header -->
        <div class="bg-gray-50 border-b border-gray-200 px-5 py-3 flex items-center justify-between">
          <div>
            <p class="font-bold text-gray-800">\${dayLabel}</p>
            <p class="text-xs text-gray-500 mt-0.5">\${uniqueWorkers.join(', ')}</p>
          </div>
          <div class="text-right">
            \${hasActive
              ? \`<span class="bg-green-100 text-green-700 text-sm px-3 py-1 rounded-full font-medium pulse">Active</span>\`
              : \`<p class="text-sm font-bold text-gray-700">\${dayHours.toFixed(1)}h</p>
                 <p class="text-sm font-bold text-green-600">$\${dayEarnings.toFixed(2)}</p>\`
            }
          </div>
        </div>
        <!-- Sessions -->
        <div class="p-3 space-y-2">
          \${sessionsHTML}
        </div>
      </div>\`
    }).join('')
  } catch(e) { console.error(e) }
}

async function loadMap() {
  const mapEl = document.getElementById('admin-map')
  
  if (!adminMap) {
    adminMap = L.map('admin-map', { attributionControl: false })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(adminMap)
  }
  
  try {
    const today = new Date().toISOString().split('T')[0]
    const res = await fetch('/api/sessions?date=' + today + '&limit=200')
    const data = await res.json()
    
    const sessions = (data.sessions || []).filter(s => s.clock_in_lat && s.clock_in_lng)
    
    if (sessions.length === 0) {
      adminMap.setView([25.2048, 55.2708], 10) // Default: Dubai
      return
    }
    
    const bounds = []
    sessions.forEach(s => {
      const color = s.status === 'active' ? '#22c55e' : '#6366f1'
      const m = L.circleMarker([s.clock_in_lat, s.clock_in_lng], {
        color, fillColor: color, fillOpacity: 0.8, radius: 10
      }).addTo(adminMap)
      m.bindPopup(\`<b>\${s.worker_name}</b><br>\${s.worker_phone}<br>In: \${new Date(s.clock_in_time).toLocaleTimeString()}\${s.clock_out_time ? '<br>Out: ' + new Date(s.clock_out_time).toLocaleTimeString() : '<br><b class="text-green-600">Currently Working</b>'}\`)
      bounds.push([s.clock_in_lat, s.clock_in_lng])
    })
    
    adminMap.fitBounds(bounds, { padding: [50, 50] })
  } catch(e) { console.error(e) }
}

// ── Workers Management ────────────────────────────────────────────────────────
function showAddWorkerModal() { document.getElementById('add-worker-modal').classList.remove('hidden') }
function closeModal() { document.getElementById('add-worker-modal').classList.add('hidden') }

async function addWorker() {
  const name = document.getElementById('modal-name').value.trim()
  const phone = document.getElementById('modal-phone').value.trim()
  const rate = parseFloat(document.getElementById('modal-rate').value) || 15
  const pin = document.getElementById('modal-pin').value.trim() || '0000'
  
  if (!name || !phone) { showAdminToast('Name and phone required', 'error'); return }
  
  try {
    const res = await fetch('/api/workers/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, hourly_rate: rate, pin })
    })
    const data = await res.json()
    if (data.worker) {
      // Update hourly rate if different
      if (rate !== data.worker.hourly_rate) {
        await fetch('/api/workers/' + data.worker.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, hourly_rate: rate, role: 'worker', active: 1 })
        })
      }
      closeModal()
      showAdminToast('Worker added successfully!', 'success')
      await loadWorkers()
    }
  } catch(e) { showAdminToast('Error adding worker', 'error') }
}

async function editWorkerRate(id, name, currentRate) {
  const newRate = prompt(\`Update hourly rate for \${name} (current: $\${currentRate}/hr):\`, currentRate)
  if (newRate === null) return
  const rate = parseFloat(newRate)
  if (isNaN(rate)) { showAdminToast('Invalid rate', 'error'); return }
  
  try {
    await fetch('/api/workers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hourly_rate: rate, role: 'worker', active: 1 })
    })
    showAdminToast('Rate updated to $' + rate + '/hr', 'success')
    await loadWorkers()
  } catch(e) { showAdminToast('Error updating rate', 'error') }
}

async function deleteWorker(id, name) {
  if (!confirm(\`Remove \${name} from the system?\`)) return
  try {
    await fetch('/api/workers/' + id, { method: 'DELETE' })
    showAdminToast(name + ' removed', 'success')
    await loadWorkers()
  } catch(e) { showAdminToast('Error removing worker', 'error') }
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV() {
  if (!allSessionsData.length) { showAdminToast('No data to export', 'error'); return }
  const headers = ['Worker', 'Phone', 'Date', 'Clock In', 'Clock Out', 'Hours', 'Earnings', 'Location', 'Status']
  const rows = allSessionsData.map(s => [
    s.worker_name || '',
    s.worker_phone || '',
    new Date(s.clock_in_time).toLocaleDateString(),
    new Date(s.clock_in_time).toLocaleTimeString(),
    s.clock_out_time ? new Date(s.clock_out_time).toLocaleTimeString() : '',
    (s.total_hours || 0).toFixed(2),
    (s.earnings || 0).toFixed(2),
    s.clock_in_lat ? \`\${s.clock_in_lat},\${s.clock_in_lng}\` : '',
    s.status
  ])
  const csv = [headers, ...rows].map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'worktracker-export-' + new Date().toISOString().split('T')[0] + '.csv'
  a.click()
  showAdminToast('CSV exported!', 'success')
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('tab-active'))
  document.getElementById('tab-' + name).classList.remove('hidden')
  document.querySelector('[data-tab="' + name + '"]').classList.add('tab-active')
  if (name === 'map') loadMap()
}

function changePeriod(period) {
  currentPeriod = period
  document.querySelectorAll('.period-btn').forEach(b => {
    b.className = b.dataset.period === period
      ? 'period-btn px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white'
      : 'period-btn px-4 py-2 rounded-xl text-sm font-medium bg-white text-gray-600 shadow-sm'
  })
  loadStats()
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showAdminToast(msg, type = 'info') {
  const t = document.getElementById('admin-toast')
  t.textContent = msg
  t.className = \`fixed bottom-6 right-6 px-5 py-3 rounded-xl shadow-xl z-50 text-sm font-medium text-white
    \${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-gray-800'}\`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 3500)
}
</script>
</body>
</html>`
}

export default app

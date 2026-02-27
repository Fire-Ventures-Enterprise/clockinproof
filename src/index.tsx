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
      headers: { 'Accept': 'application/json', 'User-Agent': 'WorkTracker/1.0' }
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
  const weekParam = c.req.query('week')
  const bounds = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  // All completed + active sessions in the week
  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(bounds.start, bounds.end).all()

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
  const weekParam = c.req.query('week')
  const bounds    = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  // Settings
  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  // Sessions
  const sessions = await db.prepare(`
    SELECT s.*,
           w.name  AS worker_name,
           w.phone AS worker_phone,
           w.hourly_rate
    FROM sessions s
    JOIN workers w ON s.worker_id = w.id
    WHERE DATE(s.clock_in_time) >= ?
      AND DATE(s.clock_in_time) <= ?
    ORDER BY w.name, s.clock_in_time ASC
  `).bind(bounds.start, bounds.end).all()

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

// POST /api/export/email  { week?: 'YYYY-MM-DD' }
// Sends the weekly report to admin email via Resend (or falls back to log)
app.post('/api/export/email', async (c) => {
  const db  = c.env.DB
  const env = c.env as any
  await ensureSchema(db)

  const body       = await c.req.json().catch(() => ({})) as any
  const weekParam  = body.week
  const bounds     = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

  const settingsRaw = await db.prepare('SELECT * FROM settings').all()
  const settings: Record<string, string> = {}
  ;(settingsRaw.results as any[]).forEach((s: any) => { settings[s.key] = s.value })

  const adminEmail = settings.admin_email || ''
  if (!adminEmail) {
    return c.json({ error: 'No admin email configured. Go to Settings → General and add your email.' }, 400)
  }

  // Build sessions data
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
  const appName  = settings.app_name || 'WorkTracker'
  const subject  = `${appName} — Weekly Report: ${bounds.label}`

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
          from: `${appName} <reports@worktracker.app>`,
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
      return c.json({ success: true, message: `Weekly report sent to ${adminEmail}`, week: bounds.label, email_id: result.id })
    } catch (e: any) {
      return c.json({ error: 'Failed to send email', detail: e.message }, 500)
    }
  }

  // No email key — return preview URL instead
  return c.json({
    success: false,
    message: 'Email not configured. Add RESEND_API_KEY secret and admin_email in Settings.',
    preview_url: `/api/export/weekly/html?week=${bounds.start}`,
    week: bounds.label
  }, 200)
})

// GET /api/export/csv?week=YYYY-MM-DD
// Returns a CSV file attachment
app.get('/api/export/csv', async (c) => {
  const db = c.env.DB
  await ensureSchema(db)
  const weekParam = c.req.query('week')
  const bounds    = getWeekBounds(weekParam ? new Date(weekParam) : undefined)

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

  // Row: one per session, with GPS proof summary
  const csvHeader = [
    'Worker', 'Phone', 'Date', 'Day',
    'Clock In', 'Clock Out', 'Hours', 'Rate/hr', 'Earnings',
    'Job Location', 'Job Description',
    'Clock-In GPS (Lat)', 'Clock-In GPS (Lng)', 'Clock-In Address',
    'Clock-Out GPS (Lat)', 'Clock-Out GPS (Lng)', 'Clock-Out Address',
    'GPS Pings Count', 'GPS Ping Times', 'GPS Ping Coords', 'Status'
  ]

  const escape = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"'

  const rows = (sessions.results as any[]).map((s: any) => {
    const sessionPings = pingsBySession[s.id] || []
    const pingTimes  = sessionPings.map((p: any) => new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).join(' | ')
    const pingCoords = sessionPings.map((p: any) => `${p.latitude},${p.longitude}`).join(' | ')
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
      pingTimes,
      pingCoords,
      s.status
    ].map(escape).join(',')
  })

  const csv = [csvHeader.map(escape).join(','), ...rows].join('\n')
  const filename = `worktracker-week-${bounds.start}.csv`

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
  const appName  = settings.app_name || 'WorkTracker'
  const subject  = `${appName} — Weekly Report: ${bounds.label}`

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${appName} <reports@worktracker.app>`,
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
  const appName = settings.app_name || 'WorkTracker'
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

      pings.forEach((p: any, i: number) => {
        allGPSPoints.push({
          time: new Date(p.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
          lat: p.latitude, lng: p.longitude,
          label: `📍 Ping #${i+1}`,
          note: `Accuracy ±${Math.round(p.accuracy || 0)}m`
        })
      })

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
                <th style="padding:5px 8px;border:1px solid #e2e8f0;">Note</th>
              </tr>
            </thead>
            <tbody>
              ${allGPSPoints.map(pt => `
                <tr>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;font-weight:600;white-space:nowrap;">${pt.time}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;">${pt.label}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;font-family:monospace;">${pt.lat !== null ? `${(pt.lat as number).toFixed(6)}, ${(pt.lng as number).toFixed(6)}` : '—'}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;">${pt.lat !== null ? `<a href="https://maps.google.com/?q=${pt.lat},${pt.lng}" style="color:#2563eb;">View Map</a>` : '—'}</td>
                  <td style="padding:5px 8px;border:1px solid #e2e8f0;font-size:10px;color:#64748b;">${pt.note.substring(0, 60)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
        : `<p style="font-size:11px;color:#94a3b8;margin-top:6px;font-style:italic;">⚠ No GPS data recorded for this shift</p>`

      const gpsStatus = allGPSPoints.length > 0
        ? `<span style="background:#dcfce7;color:#166534;font-size:10px;padding:2px 7px;border-radius:999px;font-weight:600;">✓ GPS Verified (${allGPSPoints.length} point${allGPSPoints.length > 1 ? 's' : ''})</span>`
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
          <!-- GPS proof table -->
          <div style="padding:10px 14px;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">GPS Location Proof</p>
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
  Object.values(sessionsByDate).forEach((sessions: any) => {
    totalHours += (sessions as any[]).reduce((s: number, x: any) => s + (x.total_hours || 0), 0)
    totalEarnings += (sessions as any[]).reduce((s: number, x: any) => s + (x.earnings || 0), 0)
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
      <button onclick="showTab('calendar')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600" data-tab="calendar">
        <i class="fas fa-calendar-alt mr-1"></i>Calendar
      </button>
      <button onclick="showTab('settings')" class="tab-btn px-6 py-4 text-sm font-medium text-gray-600" data-tab="settings">
        <i class="fas fa-cog mr-1"></i>Settings
      </button>
      <button onclick="showTab('export')" class="tab-btn px-5 py-4 text-sm font-medium text-gray-600" data-tab="export">
        <i class="fas fa-file-export mr-1"></i>Export
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

    <!-- Tab: Calendar -->
    <div id="tab-calendar" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
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
    <div id="tab-settings" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
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
    <div id="tab-export" class="tab-content hidden bg-white rounded-b-2xl rounded-tr-2xl shadow-sm p-5">
      <h3 class="font-bold text-gray-700 mb-5 flex items-center gap-2">
        <i class="fas fa-file-export text-indigo-500"></i> Weekly Export & Email Report
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

      <!-- Export actions -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">

        <!-- View HTML Report -->
        <div class="border-2 border-indigo-100 rounded-2xl p-5 hover:border-indigo-300 transition-colors">
          <div class="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center mb-3">
            <i class="fas fa-eye text-indigo-600 text-xl"></i>
          </div>
          <h4 class="font-bold text-gray-800 mb-1">View Report</h4>
          <p class="text-xs text-gray-500 mb-4">Full proof report with GPS timeline. Print or save as PDF directly from browser.</p>
          <button onclick="viewWeeklyReport()"
            class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-xl text-sm">
            <i class="fas fa-external-link-alt mr-1"></i>Open Report
          </button>
        </div>

        <!-- Download CSV -->
        <div class="border-2 border-green-100 rounded-2xl p-5 hover:border-green-300 transition-colors">
          <div class="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center mb-3">
            <i class="fas fa-file-csv text-green-600 text-xl"></i>
          </div>
          <h4 class="font-bold text-gray-800 mb-1">Download CSV</h4>
          <p class="text-xs text-gray-500 mb-4">Spreadsheet with all sessions, GPS coordinates, hours and earnings. Opens in Excel.</p>
          <button onclick="downloadCSV()"
            class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl text-sm">
            <i class="fas fa-download mr-1"></i>Download .CSV
          </button>
        </div>

        <!-- Email Report -->
        <div class="border-2 border-amber-100 rounded-2xl p-5 hover:border-amber-300 transition-colors">
          <div class="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center mb-3">
            <i class="fas fa-envelope text-amber-600 text-xl"></i>
          </div>
          <h4 class="font-bold text-gray-800 mb-1">Email Report</h4>
          <p class="text-xs text-gray-500 mb-4">Send the full HTML report to admin email. Requires RESEND_API_KEY secret.</p>
          <button onclick="emailWeeklyReport()" id="email-report-btn"
            class="w-full bg-amber-500 hover:bg-amber-600 text-white font-semibold py-2.5 rounded-xl text-sm">
            <i class="fas fa-paper-plane mr-1"></i>Send Email
          </button>
        </div>
      </div>

      <!-- Email config status -->
      <div id="export-email-status" class="hidden rounded-xl p-4 mb-4 text-sm"></div>

      <!-- Auto schedule info -->
      <div class="bg-gray-50 border border-gray-200 rounded-2xl p-5">
        <h4 class="font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <i class="fas fa-robot text-indigo-500"></i> Automatic Weekly Email Schedule
        </h4>
        <div class="space-y-2 text-sm text-gray-600">
          <div class="flex items-start gap-2">
            <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
            <span><strong>Schedule:</strong> Every Friday at 11:59 PM (end of workweek) — covers Monday 12:00 AM to Friday 11:59 PM</span>
          </div>
          <div class="flex items-start gap-2">
            <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
            <span><strong>Content:</strong> Full GPS proof for every shift + hours + earnings per worker</span>
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
        <div class="mt-4 bg-white border border-gray-200 rounded-xl p-3">
          <p class="text-xs font-semibold text-gray-500 mb-2">To enable automatic emails:</p>
          <ol class="text-xs text-gray-600 space-y-1 list-decimal list-inside">
            <li>Go to <strong>Settings</strong> tab → General → enter your admin email</li>
            <li>In Cloudflare dashboard → Workers → your app → Settings → Variables → add <code class="bg-gray-100 px-1 rounded">RESEND_API_KEY</code></li>
            <li>Get a free API key at <a href="https://resend.com" target="_blank" class="text-blue-500 hover:underline">resend.com</a> (free tier: 100 emails/day)</li>
            <li>Deploy app to Cloudflare Workers (cron triggers require Workers, not Pages)</li>
          </ol>
        </div>
      </div>
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
  if (name === 'calendar') loadCalendar()
  if (name === 'settings') loadSettings()
  if (name === 'export') initExportTab()
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

// ── Calendar ──────────────────────────────────────────────────────────────────
let calYear = new Date().getFullYear()
let calMonth = new Date().getMonth() + 1  // 1-based
let calHolidays = []
let calSchedule = {}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function calPrevMonth() { calMonth--; if (calMonth < 1) { calMonth = 12; calYear-- } loadCalendar() }
function calNextMonth() { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++ } loadCalendar() }
function calGoToday()   { calYear = new Date().getFullYear(); calMonth = new Date().getMonth() + 1; loadCalendar() }

async function loadCalendar() {
  document.getElementById('cal-month-label').textContent = MONTH_NAMES[calMonth - 1] + ' ' + calYear

  // Populate worker filter if empty
  const wSel = document.getElementById('cal-worker-filter')
  if (wSel && wSel.options.length <= 1) {
    try {
      const wr = await fetch('/api/workers')
      const wd = await wr.json()
      if (wd.workers) {
        wd.workers.forEach(w => {
          const opt = document.createElement('option')
          opt.value = w.id; opt.textContent = w.name
          wSel.appendChild(opt)
        })
      }
    } catch(e) {}
  }

  const workerId = document.getElementById('cal-worker-filter').value

  try {
    // Fetch calendar data + holidays in parallel
    const [calRes, holRes] = await Promise.all([
      fetch(\`/api/calendar/\${calYear}/\${calMonth}\${workerId ? '?worker_id=' + workerId : ''}\`),
      fetch(\`/api/holidays/\${calYear}\`)
    ])
    const calData = await calRes.json()
    const holData = await holRes.json()

    calSchedule = calData.settings || {}
    calHolidays = holData.holidays || []

    renderCalendar(calData)
    renderCalendarSummary(calData)
    renderHolidayList(calData)
  } catch(e) { console.error('Calendar error:', e) }
}

function renderCalendar(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = (calData.settings?.work_days || [1,2,3,4,5])
  const today = new Date().toISOString().split('T')[0]

  // Get holiday dates as a set for fast lookup
  const holidayMap = {}
  calHolidays.forEach(h => { holidayMap[h.date] = h })

  // Build grid: first day of month
  const firstDay = new Date(calYear, calMonth - 1, 1).getDay()  // 0=Sun
  const daysInMonth = new Date(calYear, calMonth, 0).getDate()

  const container = document.getElementById('cal-days')
  let html = ''

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += \`<div class="min-h-[80px] rounded-xl bg-gray-50 opacity-40"></div>\`
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = \`\${calYear}-\${String(calMonth).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`
    const dow = new Date(calYear, calMonth - 1, d).getDay()
    const isWeekend = !workDays.includes(dow)
    const isToday = dateStr === today
    const isHoliday = !!holidayMap[dateStr]
    const sessions = sessionsByDate[dateStr] || []
    const hasSessions = sessions.length > 0
    const totalHours = sessions.reduce((s, x) => s + (x.total_hours || 0), 0)
    const totalEarnings = sessions.reduce((s, x) => s + (x.earnings || 0), 0)
    const hasActive = sessions.some(s => s.status === 'active')

    let cellClass = 'min-h-[80px] rounded-xl p-2 border text-xs cursor-default transition-all hover:shadow-sm '
    if (isToday)          cellClass += 'bg-yellow-50 border-yellow-400 ring-2 ring-yellow-300 '
    else if (isHoliday)   cellClass += 'bg-red-50 border-red-300 '
    else if (isWeekend)   cellClass += 'bg-gray-100 border-gray-200 '
    else if (hasSessions) cellClass += 'bg-green-50 border-green-300 '
    else                  cellClass += 'bg-blue-50 border-blue-100 '

    const holiday = holidayMap[dateStr]

    html += \`<div class="\${cellClass}">
      <div class="flex items-start justify-between mb-1">
        <span class="font-bold text-sm \${isToday ? 'text-yellow-700' : isHoliday ? 'text-red-700' : isWeekend ? 'text-gray-400' : 'text-gray-700'}">\${d}</span>
        \${isHoliday ? \`<span class="text-red-500" title="\${holiday.name}"><i class="fas fa-star" style="font-size:9px"></i></span>\` : ''}
        \${hasActive ? \`<span class="text-green-500 pulse"><i class="fas fa-circle" style="font-size:7px"></i></span>\` : ''}
      </div>
      \${holiday ? \`<p class="text-red-600 leading-tight mb-1" style="font-size:9px">\${holiday.name.substring(0,18)}</p>\` : ''}
      \${hasSessions ? \`
        <div class="bg-white bg-opacity-70 rounded-lg px-1.5 py-1 mt-1">
          <p class="font-bold text-green-700">\${totalHours.toFixed(1)}h</p>
          <p class="text-green-600">$\${totalEarnings.toFixed(0)}</p>
          <p class="text-gray-400">\${sessions.length} shift\${sessions.length > 1 ? 's' : ''}</p>
        </div>
      \` : isWeekend ? \`<p style="font-size:9px" class="text-gray-400 mt-1">Off</p>\`
         : isHoliday ? \`<p style="font-size:9px" class="text-red-400 mt-1">Stat Holiday</p>\`
         : \`<p style="font-size:9px" class="text-gray-300 mt-1">No shift</p>\`}
    </div>\`
  }

  container.innerHTML = html
}

function renderCalendarSummary(calData) {
  const sessionsByDate = calData.sessions_by_date || {}
  const workDays = calData.settings?.work_days || [1,2,3,4,5]
  const paidHours = calData.settings?.paid_hours_per_day || 7.5
  const daysInMonth = new Date(calYear, calMonth, 0).getDate()

  // Count workdays, holidays in month
  const holidayDates = new Set(calHolidays.map(h => h.date))
  let workdayCount = 0
  let statDayCount = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = \`\${calYear}-\${String(calMonth).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`
    const dow = new Date(calYear, calMonth - 1, d).getDay()
    if (workDays.includes(dow)) {
      if (holidayDates.has(dateStr)) statDayCount++
      else workdayCount++
    }
  }

  let totalHours = 0, totalEarnings = 0, daysWorked = 0
  Object.values(sessionsByDate).forEach((sessions: any) => {
    const dayH = (sessions as any[]).reduce((s: number, x: any) => s + (x.total_hours || 0), 0)
    const dayE = (sessions as any[]).reduce((s: number, x: any) => s + (x.earnings || 0), 0)
    totalHours += dayH; totalEarnings += dayE; daysWorked++
  })

  const expectedHours = workdayCount * paidHours
  const coverage = expectedHours > 0 ? Math.min(100, Math.round((totalHours / expectedHours) * 100)) : 0

  document.getElementById('cal-summary').innerHTML = \`
    <div class="bg-blue-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-blue-700">\${workdayCount}</p>
      <p class="text-xs text-blue-500 mt-0.5">Workdays</p>
    </div>
    <div class="bg-red-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-red-600">\${statDayCount}</p>
      <p class="text-xs text-red-500 mt-0.5">Stat Holidays</p>
    </div>
    <div class="bg-green-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-green-700">\${totalHours.toFixed(1)}h</p>
      <p class="text-xs text-green-500 mt-0.5">Hrs Worked (\${daysWorked} days)</p>
    </div>
    <div class="bg-purple-50 rounded-xl p-3 text-center">
      <p class="text-2xl font-bold text-purple-700">$\${totalEarnings.toFixed(0)}</p>
      <p class="text-xs text-purple-500 mt-0.5">Total Earned</p>
    </div>
  \`
}

function renderHolidayList(calData) {
  const provinceHols = calHolidays.filter(h => {
    const d = new Date(h.date)
    return d.getFullYear() === calYear && d.getMonth() + 1 === calMonth
  })

  if (provinceHols.length === 0) {
    document.getElementById('cal-holidays').innerHTML = ''
    return
  }

  const html = \`<div class="mt-2 border border-gray-200 rounded-2xl overflow-hidden">
    <div class="bg-red-50 border-b border-red-100 px-4 py-2.5 flex items-center gap-2">
      <i class="fas fa-star text-red-500 text-xs"></i>
      <h4 class="font-bold text-red-700 text-sm">Statutory Holidays in \${MONTH_NAMES[calMonth-1]}</h4>
    </div>
    <div class="divide-y divide-gray-100">
      \${provinceHols.map(h => \`
        <div class="px-4 py-3 flex items-center justify-between">
          <div>
            <p class="font-medium text-gray-800 text-sm">\${h.name}</p>
            <p class="text-xs text-gray-500">\${new Date(h.date + 'T12:00:00').toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'})}</p>
          </div>
          <span class="bg-amber-100 text-amber-700 text-xs px-2.5 py-1 rounded-full font-semibold">
            \${h.stat_multiplier || 1.5}× pay
          </span>
        </div>
      \`).join('')}
    </div>
  </div>\`

  document.getElementById('cal-holidays').innerHTML = html
}

// ── Settings ──────────────────────────────────────────────────────────────────
const PROVINCE_DATA = {
  'CA': [
    {code:'ON', name:'Ontario'}, {code:'BC', name:'British Columbia'},
    {code:'AB', name:'Alberta'}, {code:'QC', name:'Quebec'},
    {code:'MB', name:'Manitoba'}, {code:'SK', name:'Saskatchewan'},
    {code:'NS', name:'Nova Scotia'}, {code:'NB', name:'New Brunswick'},
    {code:'PE', name:'Prince Edward Island'}, {code:'NL', name:'Newfoundland & Labrador'},
    {code:'NT', name:'Northwest Territories'}, {code:'YT', name:'Yukon'},
    {code:'NU', name:'Nunavut'}
  ],
  'US': [
    {code:'CA', name:'California'}, {code:'NY', name:'New York'},
    {code:'TX', name:'Texas'}, {code:'FL', name:'Florida'},
    {code:'WA', name:'Washington'}, {code:'OR', name:'Oregon'},
    {code:'MA', name:'Massachusetts'}, {code:'IL', name:'Illinois'},
    {code:'CO', name:'Colorado'}, {code:'AZ', name:'Arizona'},
    {code:'GA', name:'Georgia'}, {code:'NC', name:'North Carolina'}
  ],
  'AU': [
    {code:'NSW', name:'New South Wales'}, {code:'VIC', name:'Victoria'},
    {code:'QLD', name:'Queensland'}, {code:'WA', name:'Western Australia'},
    {code:'SA', name:'South Australia'}, {code:'TAS', name:'Tasmania'},
    {code:'ACT', name:'Australian Capital Territory'}, {code:'NT', name:'Northern Territory'}
  ],
  'GB': [ {code:'ENG', name:'England'}, {code:'WLS', name:'Wales'}, {code:'SCT', name:'Scotland'}, {code:'NIR', name:'Northern Ireland'} ],
  'NZ': [ {code:'NZ', name:'New Zealand'} ],
  'DE': [ {code:'DE', name:'Germany'} ],
  'FR': [ {code:'FR', name:'France'} ]
}

const STAT_MULTIPLIERS = {
  'CA-ON':1.5,'CA-BC':1.5,'CA-AB':1.5,'CA-QC':1.0,'CA-MB':1.5,'CA-SK':1.5,
  'CA-NS':1.5,'CA-NB':1.5,'CA-PE':1.5,'CA-NL':2.0,'CA-NT':1.5,'CA-YT':1.5,'CA-NU':1.5,
  'US-CA':1.5,'US-NY':1.5,'US-TX':1.5,'US-FL':1.5,'US-WA':1.5,'US-OR':1.5,
  'US-MA':1.5,'US-IL':1.5,'AU-NSW':2.0,'AU-VIC':2.0,'AU-QLD':2.0,'GB-ENG':1.0
}

const STAT_PAY_NOTES = {
  'CA-ON': 'Ontario: 1.5× for working on stat holidays + regular pay for the day.',
  'CA-BC': 'BC: Must receive regular day\'s pay for stat; 1.5× if working.',
  'CA-AB': 'Alberta: General holidays — regular pay off or 1.5× if working.',
  'CA-QC': 'Quebec: Regular pay for the stat day; no premium for working (unless collective agreement).',
  'CA-MB': 'Manitoba: 1.5× for working on a general holiday.',
  'CA-SK': 'Saskatchewan: 1.5× for working on statutory holidays.',
  'CA-NL': 'Newfoundland: 2× pay for working on public holidays.',
  'US-CA': 'California: No state mandate; federal FLSA has no holiday premium. Industry standard 1.5×.',
  'US-NY': 'New York: No state mandate for holiday premium pay. 1.5× is common practice.',
  'US-TX': 'Texas: Follows federal FLSA — no holiday pay mandate. 1.5× by employer policy.',
  'AU-NSW': 'NSW: Double time for working on public holidays (penalty rates).',
  'AU-VIC': 'Victoria: Double time for public holiday work.',
  'GB-ENG': 'England: No legal right to extra pay on bank holidays (contract dependent).'
}

let currentSettings = {}
let activeDays = [1,2,3,4,5]

async function loadSettings() {
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    currentSettings = data.settings || {}

    document.getElementById('s-app-name').value = currentSettings.app_name || 'WorkTracker'
    document.getElementById('s-hourly-rate').value = currentSettings.default_hourly_rate || '15.00'
    document.getElementById('s-admin-pin').value = currentSettings.admin_pin || '1234'
    document.getElementById('s-admin-email').value = currentSettings.admin_email || ''
    document.getElementById('s-city').value = currentSettings.city || ''
    document.getElementById('s-work-start').value = currentSettings.work_start || '08:00'
    document.getElementById('s-work-end').value = currentSettings.work_end || '16:00'
    document.getElementById('s-break-morning').value = currentSettings.break_morning_min || '15'
    document.getElementById('s-break-lunch').value = currentSettings.break_lunch_min || '30'
    document.getElementById('s-break-afternoon').value = currentSettings.break_afternoon_min || '15'
    document.getElementById('s-paid-hours').value = currentSettings.paid_hours_per_day || '7.5'
    document.getElementById('s-stat-multiplier').value = currentSettings.stat_pay_multiplier || '1.5'

    // Country dropdown
    const country = currentSettings.country_code || 'CA'
    document.getElementById('s-country').value = country
    updateProvinceList(currentSettings.province_code)

    // Timezone
    const tzSel = document.getElementById('s-timezone')
    if (tzSel) tzSel.value = currentSettings.timezone || 'America/Toronto'

    // Work days
    activeDays = (currentSettings.work_days || '1,2,3,4,5').split(',').map(Number)
    document.querySelectorAll('.work-day-btn').forEach(btn => {
      const day = parseInt(btn.dataset.day)
      if (activeDays.includes(day)) {
        btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white'
      } else {
        btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50'
      }
    })

    updateStatPayInfo(country, currentSettings.province_code || 'ON')
  } catch(e) { console.error(e) }
}

function updateProvinceList(selectedProvince = null) {
  const country = document.getElementById('s-country').value
  const provSel = document.getElementById('s-province')
  const provinces = PROVINCE_DATA[country] || []
  provSel.innerHTML = provinces.map(p =>
    \`<option value="\${p.code}" \${(selectedProvince || currentSettings.province_code) === p.code ? 'selected' : ''}>\${p.name}</option>\`
  ).join('')
  // Auto-update stat multiplier when province changes
  const pcode = provSel.value
  const key = country + '-' + pcode
  const mult = STAT_MULTIPLIERS[key] || 1.5
  document.getElementById('s-stat-multiplier').value = mult
  updateStatPayInfo(country, pcode)
}

function updateStatPayInfo(country, province) {
  const key = country + '-' + province
  const note = STAT_PAY_NOTES[key] || \`Standard stat pay: \${STAT_MULTIPLIERS[key] || 1.5}× for working on statutory holidays.\`
  const mult = STAT_MULTIPLIERS[key] || 1.5
  document.getElementById('stat-pay-info').innerHTML = \`
    <p><strong>Jurisdiction:</strong> \${key}</p>
    <p><strong>Rate:</strong> \${mult}× pay on statutory holidays</p>
    <p class="mt-1 italic">\${note}</p>
  \`
}

function toggleDay(day) {
  const idx = activeDays.indexOf(day)
  if (idx >= 0) activeDays.splice(idx, 1)
  else activeDays.push(day)
  activeDays.sort()
  document.querySelectorAll('.work-day-btn').forEach(btn => {
    const d = parseInt(btn.dataset.day)
    if (activeDays.includes(d)) {
      btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-indigo-600 text-white'
    } else {
      btn.className = 'work-day-btn px-3 py-2 text-xs rounded-xl border font-medium bg-gray-100 text-gray-500 hover:bg-indigo-50'
    }
  })
}

async function saveSettings() {
  const country = document.getElementById('s-country').value
  const province = document.getElementById('s-province').value
  const key = country + '-' + province
  const mult = document.getElementById('s-stat-multiplier').value

  const payload = {
    app_name: document.getElementById('s-app-name').value.trim(),
    default_hourly_rate: document.getElementById('s-hourly-rate').value,
    admin_pin: document.getElementById('s-admin-pin').value.trim(),
    admin_email: document.getElementById('s-admin-email').value.trim(),
    country_code: country,
    province_code: province,
    city: document.getElementById('s-city').value.trim(),
    timezone: document.getElementById('s-timezone').value,
    work_start: document.getElementById('s-work-start').value,
    work_end: document.getElementById('s-work-end').value,
    break_morning_min: document.getElementById('s-break-morning').value,
    break_lunch_min: document.getElementById('s-break-lunch').value,
    break_afternoon_min: document.getElementById('s-break-afternoon').value,
    paid_hours_per_day: document.getElementById('s-paid-hours').value,
    stat_pay_multiplier: mult,
    work_days: activeDays.join(',')
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.ok) {
      showAdminToast('Settings saved! ✅', 'success')
      currentSettings = payload
    } else {
      showAdminToast('Failed to save settings', 'error')
    }
  } catch(e) { showAdminToast('Error saving settings', 'error') }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Export Tab ────────────────────────────────────────────────────────────────
function getMonWeekStart(offsetWeeks = 0) {
  const d = new Date()
  const day = d.getDay()
  const diffToMon = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diffToMon + offsetWeeks * 7)
  return d.toISOString().split('T')[0]
}

function setExportWeek(offset) {
  const monDate = getMonWeekStart(offset)
  document.getElementById('export-week-date').value = monDate
  updateExportWeekLabel()
}

function updateExportWeekLabel() {
  const dateVal = document.getElementById('export-week-date').value
  if (!dateVal) { document.getElementById('export-week-label').textContent = '—'; return }
  const d = new Date(dateVal + 'T12:00:00')
  const day = d.getDay()
  const diffToMon = day === 0 ? -6 : 1 - day
  const mon = new Date(d); mon.setDate(d.getDate() + diffToMon)
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4)
  const fmt = dt => dt.toLocaleDateString('en-CA', { weekday:'short', month:'short', day:'numeric' })
  document.getElementById('export-week-label').textContent = fmt(mon) + ' → ' + fmt(fri)
}

async function initExportTab() {
  setExportWeek(0)  // default to current week
  document.getElementById('export-week-date').addEventListener('change', updateExportWeekLabel)

  // Load last email sent time
  try {
    const res = await fetch('/api/settings')
    const data = await res.json()
    const s = data.settings || {}
    if (s.last_weekly_email_sent) {
      document.getElementById('last-email-sent-info').textContent =
        'Last sent: ' + new Date(s.last_weekly_email_sent).toLocaleString()
    }
    if (s.admin_email) {
      document.getElementById('auto-email-config-status').innerHTML = \`
        <i class="fas fa-check-circle text-green-500 mt-0.5 flex-shrink-0"></i>
        <span><strong>Email configured:</strong> Reports will be sent to <strong>\${s.admin_email}</strong> every Friday night</span>
      \`
    }
  } catch(e) {}
}

function viewWeeklyReport() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }
  window.open('/api/export/weekly/html?week=' + week, '_blank')
}

function downloadCSV() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }
  window.location.href = '/api/export/csv?week=' + week
  showAdminToast('CSV download started!', 'success')
}

async function emailWeeklyReport() {
  const week = document.getElementById('export-week-date').value
  if (!week) { showAdminToast('Select a week first', 'error'); return }

  const btn = document.getElementById('email-report-btn')
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-1"></i>Sending...'

  const statusEl = document.getElementById('export-email-status')
  statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-blue-50 border border-blue-200 text-blue-700'
  statusEl.classList.remove('hidden')
  statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>Sending email report...'

  try {
    const res = await fetch('/api/export/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week })
    })
    const data = await res.json()

    if (data.success) {
      statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-green-50 border border-green-200 text-green-800'
      statusEl.innerHTML = \`<i class="fas fa-check-circle mr-2"></i><strong>Report sent!</strong> \${data.message}\`
      showAdminToast('Weekly report emailed! ✅', 'success')
      document.getElementById('last-email-sent-info').textContent = 'Last sent: ' + new Date().toLocaleString()
    } else {
      statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-800'
      statusEl.innerHTML = \`
        <p class="font-semibold mb-1"><i class="fas fa-exclamation-triangle mr-2"></i>Email not yet configured</p>
        <p class="text-xs mb-2">\${data.message || ''}</p>
        \${data.preview_url ? \`<a href="\${data.preview_url}" target="_blank" class="text-blue-600 underline text-xs font-medium"><i class="fas fa-external-link-alt mr-1"></i>View report in browser instead</a>\` : ''}
      \`
    }
  } catch(e) {
    statusEl.className = 'rounded-xl p-4 mb-4 text-sm bg-red-50 border border-red-200 text-red-700'
    statusEl.innerHTML = '<i class="fas fa-times-circle mr-2"></i>Failed to send. Check console for details.'
  }

  btn.disabled = false
  btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Send Email'
}

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

// ─── CLOUDFLARE SCHEDULED TRIGGER ────────────────────────────────────────────
// Fires every Friday at 23:59 UTC  →  cron: "59 23 * * 5"
export default {
  fetch: app.fetch,
  async scheduled(_event: any, env: any, _ctx: any) {
    await runWeeklyEmailJob(env.DB as D1Database, env)
  }
}

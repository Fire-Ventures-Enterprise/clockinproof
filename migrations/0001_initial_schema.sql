-- WorkTracker Database Schema

-- Workers table (employees tracked by phone)
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  device_id TEXT,
  hourly_rate REAL DEFAULT 0,
  role TEXT DEFAULT 'worker',
  active INTEGER DEFAULT 1,
  pin TEXT DEFAULT '0000',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Work sessions (clock in / clock out events)
CREATE TABLE IF NOT EXISTS sessions (
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
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (worker_id) REFERENCES workers(id)
);

-- Location pings (periodic GPS tracking while clocked in)
CREATE TABLE IF NOT EXISTS location_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  worker_id INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  accuracy REAL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (worker_id) REFERENCES workers(id)
);

-- Admin settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_worker_id ON sessions(worker_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_location_pings_session_id ON location_pings(session_id);
CREATE INDEX IF NOT EXISTS idx_workers_phone ON workers(phone);

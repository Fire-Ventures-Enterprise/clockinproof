-- Seed data for WorkTracker

-- Default admin settings
INSERT OR IGNORE INTO settings (key, value) VALUES 
  ('app_name', 'WorkTracker'),
  ('default_hourly_rate', '15.00'),
  ('timezone', 'UTC'),
  ('admin_pin', '1234');

-- Sample workers
INSERT OR IGNORE INTO workers (name, phone, hourly_rate, role, pin) VALUES 
  ('Admin User', '+10000000000', 25.00, 'admin', '1234'),
  ('Ahmed Hassan', '+9665xxxxxxx', 18.00, 'worker', '1111'),
  ('Sara Ali', '+9665xxxxxxy', 20.00, 'worker', '2222');

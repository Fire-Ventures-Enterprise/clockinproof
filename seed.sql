-- Seed data for WorkTracker

-- Default admin settings
INSERT OR IGNORE INTO settings (key, value) VALUES 
  ('app_name', 'WorkTracker'),
  ('default_hourly_rate', '15.00'),
  ('timezone', 'UTC'),
  ('admin_pin', '1234');


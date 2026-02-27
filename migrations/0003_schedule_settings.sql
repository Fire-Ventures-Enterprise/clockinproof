-- Add work schedule and location settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('country_code', 'CA');
INSERT OR IGNORE INTO settings (key, value) VALUES ('province_code', 'ON');
INSERT OR IGNORE INTO settings (key, value) VALUES ('city', 'Toronto');
INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'America/Toronto');
INSERT OR IGNORE INTO settings (key, value) VALUES ('work_start', '08:00');
INSERT OR IGNORE INTO settings (key, value) VALUES ('work_end', '16:00');
INSERT OR IGNORE INTO settings (key, value) VALUES ('break_morning_min', '15');
INSERT OR IGNORE INTO settings (key, value) VALUES ('break_lunch_min', '30');
INSERT OR IGNORE INTO settings (key, value) VALUES ('break_afternoon_min', '15');
INSERT OR IGNORE INTO settings (key, value) VALUES ('paid_hours_per_day', '7.5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('work_days', '1,2,3,4,5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('stat_pay_multiplier', '1.5');

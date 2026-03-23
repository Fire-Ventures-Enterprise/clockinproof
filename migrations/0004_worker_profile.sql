-- Worker profile fields: contact info, employment details, driver's license
ALTER TABLE workers ADD COLUMN email TEXT;
ALTER TABLE workers ADD COLUMN home_address TEXT;
ALTER TABLE workers ADD COLUMN job_title TEXT;
ALTER TABLE workers ADD COLUMN start_date TEXT;
ALTER TABLE workers ADD COLUMN pay_type TEXT DEFAULT 'hourly';
ALTER TABLE workers ADD COLUMN salary_amount REAL DEFAULT 0;
ALTER TABLE workers ADD COLUMN drivers_license_number TEXT;
ALTER TABLE workers ADD COLUMN license_front_b64 TEXT;
ALTER TABLE workers ADD COLUMN license_back_b64 TEXT;
ALTER TABLE workers ADD COLUMN emergency_contact TEXT;
ALTER TABLE workers ADD COLUMN notes TEXT;

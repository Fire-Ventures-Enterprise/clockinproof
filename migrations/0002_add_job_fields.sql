-- Add job location and task description to sessions
ALTER TABLE sessions ADD COLUMN job_location TEXT;
ALTER TABLE sessions ADD COLUMN job_description TEXT;

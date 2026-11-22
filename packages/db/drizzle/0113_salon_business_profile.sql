ALTER TABLE salon_settings ADD COLUMN business_profile jsonb NOT NULL DEFAULT '{}'::jsonb;

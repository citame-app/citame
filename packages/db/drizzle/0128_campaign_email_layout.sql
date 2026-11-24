ALTER TABLE marketing_campaign
  ADD COLUMN email_layout jsonb,
  ADD CONSTRAINT marketing_campaign_email_layout_valid
    CHECK (email_layout IS NULL OR (channel <> 'sms' AND jsonb_typeof(email_layout) = 'object'));

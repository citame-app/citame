ALTER TABLE gift_card
  ADD COLUMN eligible_services jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT gift_card_eligible_services_valid
    CHECK (jsonb_typeof(eligible_services) = 'array' AND jsonb_array_length(eligible_services) <= 50);

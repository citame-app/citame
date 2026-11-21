CREATE TABLE stamp_program (
  id integer PRIMARY KEY DEFAULT 1,
  terms jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  minimum_card_version integer NOT NULL DEFAULT 1,
  last_request text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stamp_program_singleton CHECK (id = 1 AND minimum_card_version BETWEEN 1 AND version)
);
--> statement-breakpoint
CREATE TABLE stamp_card (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id uuid NOT NULL REFERENCES client_profile (id),
  program_version integer NOT NULL,
  program jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  stamps integer NOT NULL,
  stamp_expires_at timestamptz,
  stamp_expiry_overridden boolean NOT NULL DEFAULT false,
  reward_expires_at timestamptz,
  completed_at timestamptz,
  reward_issued_at timestamptz,
  redeemed_at timestamptz,
  voided_at timestamptz,
  needs_review boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stamp_card_revision CHECK (version > 0 AND program_version > 0),
  CONSTRAINT stamp_card_count CHECK (stamps BETWEEN 0 AND 15),
  CONSTRAINT stamp_card_lifecycle CHECK (
    (reward_issued_at IS NULL OR completed_at IS NOT NULL) AND
    (redeemed_at IS NULL OR reward_issued_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX stamp_card_client_idx ON stamp_card (client_id, created_at);
--> statement-breakpoint
CREATE TABLE stamp_card_event (
  source text PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES stamp_card (id),
  checkout_id uuid UNIQUE REFERENCES checkout (id),
  request_hash text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX stamp_card_event_card_idx ON stamp_card_event (card_id);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_stamp_program
AFTER INSERT OR UPDATE ON stamp_program DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_stamp_card
AFTER INSERT OR UPDATE ON stamp_card DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');

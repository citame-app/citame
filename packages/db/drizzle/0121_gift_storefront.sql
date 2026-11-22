CREATE TABLE gift_offer (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  theme text NOT NULL DEFAULT 'rose',
  amount_cents integer NOT NULL,
  price_cents integer NOT NULL,
  validity_days integer,
  eligible_service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  published boolean NOT NULL DEFAULT false,
  catalogue_review text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gift_offer_terms_valid CHECK (
    char_length(name) BETWEEN 1 AND 120 AND char_length(description) <= 500
    AND theme IN ('rose', 'sage', 'ink')
    AND amount_cents BETWEEN 1 AND 999999999 AND price_cents BETWEEN 1 AND 999999999
    AND (validity_days IS NULL OR validity_days BETWEEN 1 AND 730)
    AND cardinality(eligible_service_ids) <= 50 AND version > 0
  )
);
--> statement-breakpoint
ALTER TABLE gift_card
  ADD COLUMN offer_id uuid REFERENCES gift_offer(id),
  ADD COLUMN offer_validity_days integer,
  ADD COLUMN offer_theme text,
  ADD CONSTRAINT gift_card_offer_theme_valid CHECK (
    offer_theme IS NULL OR (offer_id IS NOT NULL AND offer_theme IN ('rose', 'sage', 'ink'))
  ),
  ADD CONSTRAINT gift_card_offer_validity_valid CHECK (
    offer_validity_days IS NULL OR (offer_id IS NOT NULL AND offer_validity_days BETWEEN 1 AND 730)
  );
--> statement-breakpoint
CREATE INDEX gift_card_pending_offer_idx ON gift_card(created_at, id)
WHERE offer_id IS NOT NULL AND status = 'pending';
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_gift_offer_commerce
AFTER INSERT OR UPDATE OR DELETE ON gift_offer
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');

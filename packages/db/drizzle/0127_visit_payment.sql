CREATE TABLE visit_payment (
  id uuid PRIMARY KEY NOT NULL,
  actor_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  group_id uuid NOT NULL,
  group_source text NOT NULL,
  method payment_method NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_payment_actor_idempotency_unique UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT visit_payment_group_source_valid CHECK (group_source IN ('itinerary', 'import')),
  CONSTRAINT visit_payment_manual_tender CHECK (method IN ('cash', 'external_card'))
);
--> statement-breakpoint
ALTER TABLE checkout_payment
  ADD COLUMN visit_payment_id uuid REFERENCES visit_payment(id),
  ADD CONSTRAINT checkout_payment_visit_receipt_unique UNIQUE (visit_payment_id, checkout_id);

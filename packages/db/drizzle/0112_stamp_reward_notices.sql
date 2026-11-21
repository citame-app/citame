ALTER TABLE stamp_card ADD COLUMN reward_notice_at timestamptz;
--> statement-breakpoint
ALTER TABLE stamp_card ADD COLUMN reward_notice_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE stamp_reward_notice_read (
  card_id uuid NOT NULL REFERENCES stamp_card (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  PRIMARY KEY (card_id, user_id)
);
--> statement-breakpoint
CREATE INDEX stamp_card_actionable_reward_idx ON stamp_card (completed_at DESC, id DESC)
WHERE completed_at IS NOT NULL AND redeemed_at IS NULL AND voided_at IS NULL AND NOT needs_review;
--> statement-breakpoint
CREATE INDEX stamp_reward_notice_user_idx ON stamp_reward_notice_read (user_id);
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_stamp_reward_notice_read
AFTER INSERT OR UPDATE ON stamp_reward_notice_read DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');

CREATE TABLE "checkout_reward" (
	"id" uuid PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"promotion_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"points_used" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"policy_version" integer,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_reward_checkoutId_unique" UNIQUE("checkout_id"),
	CONSTRAINT "checkout_reward_valid" CHECK ("checkout_reward"."points_used">=0 and "checkout_reward"."discount_cents">0 and "checkout_reward"."state" in ('held','applied','released') and (("checkout_reward"."kind"='points' and "checkout_reward"."points_used">0 and "checkout_reward"."promotion_id" is null) or ("checkout_reward"."kind"='promotion' and "checkout_reward"."points_used"=0 and "checkout_reward"."promotion_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "checkout_reward_lot" (
	"reward_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"points" integer NOT NULL,
	CONSTRAINT "checkout_reward_lot_reward_id_lot_id_pk" PRIMARY KEY("reward_id","lot_id"),
	CONSTRAINT "checkout_reward_lot_points_positive" CHECK ("checkout_reward_lot"."points">0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_lot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"checkout_id" uuid,
	"granted_points" integer NOT NULL,
	"remaining_points" integer NOT NULL,
	"spent_points" integer DEFAULT 0 NOT NULL,
	"expired_points" integer DEFAULT 0 NOT NULL,
	"revoked_unused_points" integer DEFAULT 0 NOT NULL,
	"revoked_spent_points" integer DEFAULT 0 NOT NULL,
	"basis_cents" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"policy_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_lot_checkoutId_unique" UNIQUE("checkout_id"),
	CONSTRAINT "loyalty_lot_conservation" CHECK ("loyalty_lot"."granted_points" between 1 and 1000000000 and "loyalty_lot"."remaining_points">=0 and "loyalty_lot"."spent_points">=0 and "loyalty_lot"."expired_points">=0 and "loyalty_lot"."revoked_unused_points">=0 and "loyalty_lot"."revoked_spent_points" between 0 and "loyalty_lot"."spent_points" and "loyalty_lot"."granted_points"="loyalty_lot"."remaining_points"+"loyalty_lot"."spent_points"+"loyalty_lot"."expired_points"+"loyalty_lot"."revoked_unused_points" and "loyalty_lot"."revoked_unused_points"+"loyalty_lot"."revoked_spent_points"<="loyalty_lot"."granted_points" and "loyalty_lot"."basis_cents">=0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"lot_id" uuid,
	"checkout_id" uuid,
	"kind" text NOT NULL,
	"points" integer NOT NULL,
	"reason" text,
	"event_key" text NOT NULL,
	"request_hash" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_movement_eventKey_unique" UNIQUE("event_key"),
	CONSTRAINT "loyalty_movement_nonzero" CHECK ("loyalty_movement"."points" <> 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_program" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"terms" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_program_singleton" CHECK ("loyalty_program"."id"=1 and "loyalty_program"."version">0)
);
--> statement-breakpoint
CREATE TABLE "promotion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"terms" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_code_unique" UNIQUE("code"),
	CONSTRAINT "promotion_version_positive" CHECK ("promotion"."version">0)
);
--> statement-breakpoint
ALTER TABLE "checkout_reward" ADD CONSTRAINT "checkout_reward_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_reward" ADD CONSTRAINT "checkout_reward_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_reward" ADD CONSTRAINT "checkout_reward_promotion_id_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_reward" ADD CONSTRAINT "checkout_reward_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_reward_lot" ADD CONSTRAINT "checkout_reward_lot_reward_id_checkout_reward_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."checkout_reward"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_reward_lot" ADD CONSTRAINT "checkout_reward_lot_lot_id_loyalty_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."loyalty_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_lot" ADD CONSTRAINT "loyalty_lot_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_movement" ADD CONSTRAINT "loyalty_movement_client_id_client_profile_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_movement" ADD CONSTRAINT "loyalty_movement_lot_id_loyalty_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."loyalty_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_movement" ADD CONSTRAINT "loyalty_movement_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_movement" ADD CONSTRAINT "loyalty_movement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_reward_promotion_idx" ON "checkout_reward" USING btree ("promotion_id","state");--> statement-breakpoint
CREATE INDEX "checkout_reward_expiry_idx" ON "checkout_reward" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "loyalty_lot_client_idx" ON "loyalty_lot" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "loyalty_movement_client_idx" ON "loyalty_movement" USING btree ("client_id","created_at");
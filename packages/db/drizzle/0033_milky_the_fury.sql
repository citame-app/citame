CREATE TABLE "portfolio_photo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"caption" text,
	"alt" text,
	"service_id" uuid,
	"service_name" text,
	"image" "bytea",
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"publication_version" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "portfolio_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "portfolio_photo_valid" CHECK ("portfolio_photo"."version">0 and "portfolio_photo"."status" in ('draft','published') and "portfolio_photo"."width" between 1 and 1024 and "portfolio_photo"."height" between 1 and 1024 and "portfolio_photo"."bytes" between 1 and 262144 and "portfolio_photo"."request_fingerprint" ~ '^[a-f0-9]{64}$' and (("portfolio_photo"."deleted_at" is null and "portfolio_photo"."image" is not null and octet_length("portfolio_photo"."image")="portfolio_photo"."bytes" and "portfolio_photo"."caption" is not null and length(btrim("portfolio_photo"."caption")) between 1 and 300 and "portfolio_photo"."alt" is not null and length(btrim("portfolio_photo"."alt")) between 1 and 300) or ("portfolio_photo"."deleted_at" is not null and "portfolio_photo"."image" is null and "portfolio_photo"."caption" is null and "portfolio_photo"."alt" is null and "portfolio_photo"."service_id" is null and "portfolio_photo"."service_name" is null and "portfolio_photo"."status"='draft')) and ("portfolio_photo"."status"<>'published' or ("portfolio_photo"."publication_version"='public-portfolio-v1' and "portfolio_photo"."publication_version" is not null and "portfolio_photo"."published_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "portfolio_photo" ADD CONSTRAINT "portfolio_photo_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_photo" ADD CONSTRAINT "portfolio_photo_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_public_id_idx" ON "portfolio_photo" USING btree ("status","id") WHERE "portfolio_photo"."deleted_at" is null;
--> statement-breakpoint
CREATE FUNCTION portfolio_preserve_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.idempotency_key,NEW.request_fingerprint,NEW.created_at,NEW.width,NEW.height,NEW.bytes)
    IS DISTINCT FROM ROW(OLD.idempotency_key,OLD.request_fingerprint,OLD.created_at,OLD.width,OLD.height,OLD.bytes)
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    OR (NEW.image IS DISTINCT FROM OLD.image AND NOT(NEW.deleted_at IS NOT NULL AND NEW.image IS NULL))
    OR (OLD.deleted_at IS NOT NULL AND (to_jsonb(NEW)-'created_by') IS DISTINCT FROM (to_jsonb(OLD)-'created_by')) THEN
    RAISE EXCEPTION 'Portfolio upload receipts and erased images are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER portfolio_upload_immutable BEFORE UPDATE ON portfolio_photo FOR EACH ROW EXECUTE FUNCTION portfolio_preserve_upload();

CREATE TABLE "client_merge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"created_by" text,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"review_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_merge_source_unique" UNIQUE("source_id"),
	CONSTRAINT "client_merge_actor_key_unique" UNIQUE("created_by","idempotency_key"),
	CONSTRAINT "client_merge_valid" CHECK ("client_merge"."source_id"<>"client_merge"."target_id" and "client_merge"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "client_merge"."review_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "client_profile" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "client_merge" ADD CONSTRAINT "client_merge_source_id_client_profile_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_merge" ADD CONSTRAINT "client_merge_target_id_client_profile_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_merge" ADD CONSTRAINT "client_merge_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_profile" ADD CONSTRAINT "client_profile_merged_into_id_client_profile_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."client_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_profile_merged_into_idx" ON "client_profile" USING btree ("merged_into_id");--> statement-breakpoint
ALTER TABLE "client_profile" ADD CONSTRAINT "client_profile_identity_valid" CHECK ("client_profile"."merged_into_id" is null or ("client_profile"."merged_into_id"<>"client_profile"."id" and "client_profile"."user_id" is null));
--> statement-breakpoint
CREATE FUNCTION client_root_id(profile_id uuid) RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE current_id uuid:=profile_id; parent_id uuid; visited uuid[]:='{}';
BEGIN
  LOOP
    IF current_id=ANY(visited) OR cardinality(visited)>=20 THEN RAISE EXCEPTION 'Invalid client identity graph' USING ERRCODE='23514'; END IF;
    visited:=array_append(visited,current_id);
    SELECT merged_into_id INTO parent_id FROM public.client_profile WHERE id=current_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF parent_id IS NULL THEN RETURN current_id; END IF;
    current_id:=parent_id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION client_identity_ids(profile_id uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH RECURSIVE members(id,depth) AS (
    SELECT public.client_root_id(profile_id),1
    UNION ALL SELECT c.id,m.depth+1 FROM public.client_profile c JOIN members m ON c.merged_into_id=m.id WHERE m.depth<20
  ) SELECT id FROM members WHERE id IS NOT NULL;
$$;
--> statement-breakpoint
CREATE FUNCTION client_merge_prepare() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_profile public.client_profile%ROWTYPE; target_profile public.client_profile%ROWTYPE; profiles integer;
BEGIN
  -- Every supported link starts by inserting its receipt, before any profile update.
  PERFORM pg_advisory_xact_lock(hashtextextended('sob-client-identity-links-v1',0));
  PERFORM id FROM public.client_profile WHERE id IN(NEW.source_id,NEW.target_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source_profile FROM public.client_profile WHERE id=NEW.source_id;
  SELECT * INTO target_profile FROM public.client_profile WHERE id=NEW.target_id;
  IF source_profile.id IS NULL OR target_profile.id IS NULL OR NEW.created_by IS NULL
     OR source_profile.id=target_profile.id OR source_profile.user_id IS NOT NULL
     OR source_profile.deleted_at IS NOT NULL OR target_profile.deleted_at IS NOT NULL
     OR source_profile.merged_into_id IS NOT NULL OR target_profile.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Review two current roots; an account must survive' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO profiles FROM (
    SELECT public.client_identity_ids(NEW.source_id) UNION SELECT public.client_identity_ids(NEW.target_id)
  ) identities;
  IF profiles>20 THEN RAISE EXCEPTION 'Client identity group exceeds twenty profiles' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_merge_prepare BEFORE INSERT ON client_merge FOR EACH ROW EXECUTE FUNCTION client_merge_prepare();
--> statement-breakpoint
CREATE FUNCTION client_identity_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.merged_into_id IS NOT NULL THEN RAISE EXCEPTION 'Create a profile before reviewing its identity link' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    RAISE EXCEPTION 'Original client identity links are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.merged_into_id IS NULL AND NEW.merged_into_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_merge m WHERE m.source_id=NEW.id AND m.target_id=NEW.merged_into_id
  ) THEN RAISE EXCEPTION 'Client identity links require a reviewed receipt first' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_identity_link_guard BEFORE INSERT OR UPDATE OF merged_into_id ON client_profile FOR EACH ROW EXECUTE FUNCTION client_identity_link_guard();
--> statement-breakpoint
CREATE FUNCTION client_merge_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.client_profile WHERE id=NEW.source_id AND merged_into_id=NEW.target_id AND user_id IS NULL) THEN
    RAISE EXCEPTION 'A merge receipt must commit with its exact identity link' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER client_merge_complete AFTER INSERT ON client_merge DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION client_merge_complete();
--> statement-breakpoint
CREATE FUNCTION client_merge_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Client merge receipts are immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'created_by') IS DISTINCT FROM (to_jsonb(OLD)-'created_by')
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'Client merge receipts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_merge_immutable BEFORE UPDATE OR DELETE ON client_merge FOR EACH ROW EXECUTE FUNCTION client_merge_immutable();

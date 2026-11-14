CREATE TABLE "sync_change" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_change_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" text NOT NULL,
	"row_id" text NOT NULL,
	"op" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_change_op_valid" CHECK ("sync_change"."op" in ('upsert', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "sync_mutation" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_mutation_status_valid" CHECK ("sync_mutation"."status" in ('applied', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "sync_mutation" ADD CONSTRAINT "sync_mutation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_change_entity_row_idx" ON "sync_change" USING btree ("entity","row_id","seq");--> statement-breakpoint
CREATE INDEX "sync_mutation_created_idx" ON "sync_mutation" USING btree ("created_at");
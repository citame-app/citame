CREATE TABLE "service_addon" (
	"addon_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "service_addon_addon_id_service_id_pk" PRIMARY KEY("addon_id","service_id"),
	CONSTRAINT "service_addon_not_self" CHECK ("service_addon"."addon_id"<>"service_addon"."service_id")
);
--> statement-breakpoint
ALTER TABLE "service" DROP CONSTRAINT "service_duration_positive";--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "catalog_kind" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "parent_service_id" uuid;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "option_label" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "catalog_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_addon" ADD CONSTRAINT "service_addon_addon_id_service_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_addon" ADD CONSTRAINT "service_addon_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_addon_target_idx" ON "service_addon" USING btree ("service_id");--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_parent_service_id_service_id_fk" FOREIGN KEY ("parent_service_id") REFERENCES "public"."service"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_parent_idx" ON "service" USING btree ("parent_service_id");--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_catalog_valid" CHECK ("service"."catalog_version">0 and (("service"."catalog_kind"='service' and "service"."parent_service_id" is null and "service"."option_label" is null) or ("service"."catalog_kind"='variant' and "service"."parent_service_id" is not null and length(trim("service"."option_label")) between 1 and 80) or ("service"."catalog_kind"='addon' and "service"."parent_service_id" is null and "service"."option_label" is null)));--> statement-breakpoint
ALTER TABLE "service" ADD CONSTRAINT "service_duration_positive" CHECK ("service"."duration_minutes" > 0 or ("service"."catalog_kind"='addon' and "service"."duration_minutes">=0));
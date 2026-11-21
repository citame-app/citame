-- No customer, form or response identifiers are carried by these markers.
CREATE CONSTRAINT TRIGGER sync_intake_form_view AFTER INSERT OR UPDATE ON intake_form
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('intake_forms');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_intake_record_view AFTER INSERT ON intake_submission
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('intake_records');
--> statement-breakpoint
-- Merges change which immutable responses are visible under the surviving identity.
CREATE CONSTRAINT TRIGGER sync_intake_record_identity AFTER UPDATE ON client_profile
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id OR
      OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION sync_record_live_view('intake_records');

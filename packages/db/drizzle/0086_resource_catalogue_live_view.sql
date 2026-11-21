CREATE CONSTRAINT TRIGGER sync_resource_catalogue_view AFTER INSERT OR UPDATE OR DELETE ON resource_pool
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('resource_catalogue');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_resource_catalogue_view AFTER INSERT OR UPDATE OR DELETE ON service_resource
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_record_live_view('resource_catalogue');

CREATE CONSTRAINT TRIGGER sync_marketing_campaign
AFTER INSERT OR UPDATE OR DELETE ON marketing_campaign
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('marketing');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_marketing_delivery_insert AFTER INSERT ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL)
EXECUTE FUNCTION sync_record_live_view('marketing');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_marketing_delivery_status AFTER UPDATE ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.campaign_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION sync_record_live_view('marketing');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_marketing_delivery_delete AFTER DELETE ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.campaign_id IS NOT NULL)
EXECUTE FUNCTION sync_record_live_view('marketing');

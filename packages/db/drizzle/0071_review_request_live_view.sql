-- A heartbeat extends a lease without changing the delivery state shown to the desk.
CREATE CONSTRAINT TRIGGER sync_review_delivery_insert AFTER INSERT ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.review_appointment_id IS NOT NULL)
EXECUTE FUNCTION sync_record_live_view('review_requests');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_review_delivery_status AFTER UPDATE ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.review_appointment_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION sync_record_live_view('review_requests');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_review_delivery_delete AFTER DELETE ON marketing_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.review_appointment_id IS NOT NULL)
EXECUTE FUNCTION sync_record_live_view('review_requests');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_review_eligibility AFTER INSERT OR DELETE ON review
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('review_requests');

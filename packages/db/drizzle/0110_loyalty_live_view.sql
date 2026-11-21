CREATE CONSTRAINT TRIGGER sync_loyalty_program
AFTER INSERT OR UPDATE OR DELETE ON loyalty_program
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_identity
AFTER UPDATE ON client_profile
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id OR
      OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_lot
AFTER INSERT OR UPDATE OR DELETE ON loyalty_lot
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_movement
AFTER INSERT OR UPDATE OR DELETE ON loyalty_movement
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_hold_insert
AFTER INSERT ON checkout_reward
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.kind = 'points' AND NEW.state = 'held')
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_hold_update
AFTER UPDATE ON checkout_reward
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
  (OLD.kind = 'points' AND OLD.state = 'held')
  IS DISTINCT FROM (NEW.kind = 'points' AND NEW.state = 'held')
  OR (
    NEW.kind = 'points' AND NEW.state = 'held'
    AND (OLD.client_id, OLD.points_used) IS DISTINCT FROM (NEW.client_id, NEW.points_used)
  )
)
EXECUTE FUNCTION sync_record_live_view('loyalty');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_loyalty_hold_delete
AFTER DELETE ON checkout_reward
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.kind = 'points' AND OLD.state = 'held')
EXECUTE FUNCTION sync_record_live_view('loyalty');

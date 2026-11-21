CREATE CONSTRAINT TRIGGER sync_promotion_lifecycle
AFTER INSERT OR UPDATE OR DELETE ON promotion
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('promotions');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_promotion_use_insert
AFTER INSERT ON checkout_reward DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.promotion_id IS NOT NULL AND NEW.state IN ('held', 'applied'))
EXECUTE FUNCTION sync_record_live_view('promotions');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_promotion_use_update
AFTER UPDATE ON checkout_reward DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
  (CASE WHEN OLD.state IN ('held', 'applied') THEN OLD.promotion_id END)
  IS DISTINCT FROM
  (CASE WHEN NEW.state IN ('held', 'applied') THEN NEW.promotion_id END)
)
EXECUTE FUNCTION sync_record_live_view('promotions');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_promotion_use_delete
AFTER DELETE ON checkout_reward DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.promotion_id IS NOT NULL AND OLD.state IN ('held', 'applied'))
EXECUTE FUNCTION sync_record_live_view('promotions');

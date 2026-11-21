CREATE CONSTRAINT TRIGGER sync_commission_payout_live_view
AFTER INSERT OR UPDATE OR DELETE ON commission_payout
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('commerce');

CREATE CONSTRAINT TRIGGER sync_email_delivery_live_view
AFTER INSERT OR UPDATE OR DELETE ON email_delivery
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('email_delivery');

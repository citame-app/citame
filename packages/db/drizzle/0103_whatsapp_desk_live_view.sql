CREATE CONSTRAINT TRIGGER sync_whatsapp_connection_live_view
AFTER INSERT OR UPDATE OR DELETE ON whatsapp_connection
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('whatsapp_desk');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_whatsapp_delivery_insert_live_view
AFTER INSERT ON reminder
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.channel = 'whatsapp')
EXECUTE FUNCTION sync_record_live_view('whatsapp_desk');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_whatsapp_delivery_update_live_view
AFTER UPDATE ON reminder
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
    (NEW.channel = 'whatsapp' OR OLD.channel = 'whatsapp')
    AND (NEW.channel, NEW.status, NEW.whatsapp_delivery, NEW.last_error, NEW.scheduled_for)
        IS DISTINCT FROM
        (OLD.channel, OLD.status, OLD.whatsapp_delivery, OLD.last_error, OLD.scheduled_for)
)
EXECUTE FUNCTION sync_record_live_view('whatsapp_desk');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_whatsapp_delivery_delete_live_view
AFTER DELETE ON reminder
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.channel = 'whatsapp')
EXECUTE FUNCTION sync_record_live_view('whatsapp_desk');

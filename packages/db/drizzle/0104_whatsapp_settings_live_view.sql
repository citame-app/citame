CREATE CONSTRAINT TRIGGER sync_whatsapp_settings_live_view
AFTER INSERT OR UPDATE OR DELETE ON whatsapp_connection
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION sync_record_live_view('whatsapp_settings');
--> statement-breakpoint
DROP TRIGGER sync_whatsapp_delivery_update_live_view ON reminder;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_whatsapp_delivery_update_live_view
AFTER UPDATE ON reminder
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (
    (NEW.channel = 'whatsapp' OR OLD.channel = 'whatsapp')
    AND (NEW.channel, NEW.kind, NEW.status, NEW.whatsapp_delivery, NEW.last_error, NEW.scheduled_for, NEW.updated_at)
        IS DISTINCT FROM
        (OLD.channel, OLD.kind, OLD.status, OLD.whatsapp_delivery, OLD.last_error, OLD.scheduled_for, OLD.updated_at)
)
EXECUTE FUNCTION sync_record_live_view('whatsapp_desk');

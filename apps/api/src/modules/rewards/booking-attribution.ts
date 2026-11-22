import { sql } from "drizzle-orm";

export const BOOKING_PROMOTION_KEY_PREFIX = "booking-promotion-";

// Both the original reward and appointment creation audit must match the receipt (alias c).
// Checkout callers can choose their own request keys.
export const confirmedBookingPromotionJoin = sql`
  join checkout_reward promotion_reward on promotion_reward.checkout_id = c.id
    and promotion_reward.kind = 'promotion' and promotion_reward.code is not null
    and promotion_reward.idempotency_key = c.idempotency_key
    and c.idempotency_key = ${BOOKING_PROMOTION_KEY_PREFIX} || c.appointment_id::text
    and exists (
      select 1 from audit_log log
      where log.entity = 'appointment' and log.entity_id = c.appointment_id::text
        and log.action = 'appointment.create' and log.created_at = c.created_at
        and (case
          when jsonb_typeof(log.metadata) = 'string'
            and pg_input_is_valid(log.metadata #>> '{}', 'jsonb')
          then (log.metadata #>> '{}')::jsonb
          else log.metadata
        end) @> '{"promotionConfirmed":true}'::jsonb
    )
`;

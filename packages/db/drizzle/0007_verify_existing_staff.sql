-- Hand-written data migration (Phase 8a, ADR 0011).
--
-- Email verification is now required before sign-in. Owners and staff were created by the
-- owner/bootstrap path (a trusted channel that picked their address), so existing ones are
-- marked verified and keep working. Clients registered through public sign-up stay unverified:
-- their next sign-in sends them a confirmation link.
UPDATE "user" SET "email_verified" = true WHERE "role" IN ('owner', 'staff') AND "email_verified" = false;

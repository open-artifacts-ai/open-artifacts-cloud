-- Recipient undo of a hosted-wide opt-out (open-artifacts#2665, #2749 card:
-- recipient-only). undo_key = HMAC(OPTOUT_STORE_KEY, the redeeming token):
-- only the exact link that added a row can remove it, so an install that
-- mints a token for an address can never undo an opt-out it didn't create.
-- NULL on bounce and complaint rows and on rows added before this. Additive.
ALTER TABLE email_optouts ADD COLUMN undo_key TEXT;
ALTER TABLE email_optouts_install ADD COLUMN undo_key TEXT;

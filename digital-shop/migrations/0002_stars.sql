ALTER TABLE orders ADD COLUMN invoice_url TEXT;
ALTER TABLE orders ADD COLUMN accepted_terms_url TEXT;
ALTER TABLE orders ADD COLUMN hold_until INTEGER;
ALTER TABLE orders ADD COLUMN checkout_query TEXT;
ALTER TABLE orders ADD COLUMN refund_request TEXT;
ALTER TABLE orders ADD COLUMN refund_started INTEGER;
ALTER TABLE stock_codes ADD COLUMN mode TEXT NOT NULL DEFAULT 'training' CHECK (mode IN ('training', 'live'));

CREATE INDEX orders_payment_state ON orders (mode, status, hold_until);
CREATE INDEX stock_codes_mode ON stock_codes (mode, product_id, variant_id, order_id);

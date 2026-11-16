CREATE TABLE shop_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  catalog TEXT CHECK (catalog IS NULL OR json_valid(catalog)),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO shop_state (id) VALUES (1);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer TEXT NOT NULL,
  submission TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('placed', 'pending_payment', 'paid', 'delivered', 'cancelled', 'refunded')),
  created_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  items TEXT NOT NULL CHECK (json_valid(items)),
  delivery TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delivery)),
  mode TEXT NOT NULL CHECK (mode IN ('training', 'live')),
  payment_charge TEXT UNIQUE,
  UNIQUE (customer, submission)
);
CREATE INDEX orders_customer ON orders (customer, created_at DESC);
CREATE INDEX orders_status ON orders (status, created_at);

CREATE TABLE stock_codes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  value TEXT NOT NULL,
  order_id TEXT REFERENCES orders (id),
  UNIQUE(product_id, variant_id, value)
);
CREATE INDEX available_codes ON stock_codes (product_id, variant_id, order_id);

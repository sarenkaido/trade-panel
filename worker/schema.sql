CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above','below')),
  target REAL NOT NULL CHECK (target > 0),
  active INTEGER NOT NULL DEFAULT 1,
  triggered_at TEXT,
  last_price REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_due ON alerts(active, triggered_at, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, created_at);

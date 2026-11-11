-- Expenses and monthly budgets.
CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,                         -- in the currency below, always positive
  currency TEXT NOT NULL,                       -- ISO 4217, e.g. UGX
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT NOT NULL DEFAULT '',
  merchant TEXT NOT NULL DEFAULT '',
  spent_on TEXT NOT NULL,                       -- local date YYYY-MM-DD
  source TEXT NOT NULL DEFAULT 'manual',        -- manual | chat | receipt
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_expenses_user_day ON expenses(user_id, spent_on);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,                       -- a spending category, or 'total' for everything
  amount REAL NOT NULL,                         -- per calendar month
  currency TEXT NOT NULL,
  alerted TEXT NOT NULL DEFAULT '',             -- "YYYY-MM:80" / "YYYY-MM:100": the last warning sent
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, category)
);

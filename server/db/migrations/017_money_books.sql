-- Money, part 2: separate books (e.g. Personal and Pharmacy), income, recurring bills, debts and
-- savings goals. Everything that already exists stays in the Personal book (book_id NULL), unchanged.

CREATE TABLE money_books (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT,                                -- NULL: the user's main currency
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, name)
);

ALTER TABLE expenses ADD COLUMN book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE;
CREATE INDEX idx_expenses_book ON expenses(user_id, book_id, spent_on);

-- Budgets: one per category per book (was one per category). Rebuilt with every row copied as is.
CREATE TABLE budgets_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  alerted TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO budgets_v2 (id, user_id, book_id, category, amount, currency, alerted, created_at, updated_at)
  SELECT id, user_id, NULL, category, amount, currency, alerted, created_at, updated_at FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_v2 RENAME TO budgets;
CREATE UNIQUE INDEX idx_budgets_book_category ON budgets(user_id, COALESCE(book_id, ''), category);

CREATE TABLE income (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',              -- who paid, e.g. "Salary", "Sales"
  note TEXT NOT NULL DEFAULT '',
  received_on TEXT NOT NULL,                    -- local date
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_income_user ON income(user_id, book_id, received_on);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'bills',
  repeat TEXT NOT NULL DEFAULT 'monthly',       -- weekly | monthly | yearly
  next_due TEXT NOT NULL,                       -- local date
  reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
  last_paid_on TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_bills_user ON bills(user_id, status, next_due);

CREATE TABLE debts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  direction TEXT NOT NULL,                      -- i_owe | owed_to_me
  amount REAL NOT NULL,                         -- the original amount
  currency TEXT NOT NULL,
  due_on TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',          -- open | settled
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE debt_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  paid_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE savings_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT REFERENCES money_books(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target REAL NOT NULL,
  currency TEXT NOT NULL,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | reached | archived
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE savings_moves (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  amount REAL NOT NULL,                         -- negative = taken out
  moved_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Supplier contact directory
-- Each row is a supplier record; sheet/columns are open-ended
CREATE TABLE IF NOT EXISTS suppliers (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  _sheet TEXT NOT NULL,
  _created_at TEXT NOT NULL DEFAULT (datetime('now')),
  _updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  Email TEXT,
  備註 TEXT,
  傳真 TEXT,
  分機 TEXT,
  廠商代號 TEXT,
  廠商名稱 TEXT,
  手機 TEXT,
  產品 TEXT,
  聯絡人 TEXT,
  聯絡電話 TEXT,
  職稱 TEXT,
  網站 TEXT,
  計價日 TEXT,
  類別 TEXT,
  職務 TEXT,
  地址 TEXT,
  廠商代碼 TEXT,
  廠商 TEXT
);
CREATE INDEX IF NOT EXISTS idx_sheet ON suppliers(_sheet);
CREATE INDEX IF NOT EXISTS idx_name ON suppliers(廠商名稱);
CREATE INDEX IF NOT EXISTS idx_sheet_name ON suppliers(_sheet, 廠商名稱);

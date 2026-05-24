-- ============================================================
-- 移行先(DXシステム側 Supabase)で1回だけ実行する全部入りスクリプト
-- ------------------------------------------------------------
-- これ1ファイルで nippo スキーマ + 全テーブル + インデックス +
-- 制約 + updated_at トリガ + PostgREST 権限 まで揃う。
--
-- 実行後にやること:
--   1) Dashboard → Project Settings → API → Exposed schemas に "nippo" を追加
--   2) 03_dump_runtime.sql の出力(View + RPC)を移行先で実行
--   3) 04_dump_data.sql の出力(INSERT)を移行先で実行
-- ============================================================


-- ------------------------------------------------------------
-- 0. スキーマと権限
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS nippo;

GRANT USAGE ON SCHEMA nippo TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- 1. updated_at 自動更新の共通関数
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


-- ------------------------------------------------------------
-- 2. テーブル
-- ------------------------------------------------------------

-- 2-1. stores
CREATE TABLE IF NOT EXISTS nippo.stores (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL,
  slug        text        NOT NULL UNIQUE,
  open_time   time        NOT NULL,
  close_time  time        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2-2. staff
CREATE TABLE IF NOT EXISTS nippo.staff (
  id          serial      PRIMARY KEY,
  store_id    integer     NOT NULL REFERENCES nippo.stores(id) ON DELETE RESTRICT,
  name        text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('head','part','support')),
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_store_id_idx ON nippo.staff (store_id);

-- 2-3. products
CREATE TABLE IF NOT EXISTS nippo.products (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL,
  category    text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 2-4. daily_reports
CREATE TABLE IF NOT EXISTS nippo.daily_reports (
  id              serial          PRIMARY KEY,
  store_id        integer         NOT NULL REFERENCES nippo.stores(id) ON DELETE RESTRICT,
  report_date     date            NOT NULL,
  weather         text            CHECK (weather IN ('sunny','cloudy','rainy','snowy')),
  event_note      text,
  sales_forecast  integer,
  sales_actual    integer,
  customer_count  integer,
  sozai_zan       integer,
  mochi_zan       integer,
  report_text     text,
  kizuki          text,
  bikou           text,
  updated_at      timestamptz     NOT NULL DEFAULT now(),
  UNIQUE (store_id, report_date)
);
CREATE INDEX IF NOT EXISTS daily_reports_date_idx ON nippo.daily_reports (report_date);

-- 2-5. shift_entries
CREATE TABLE IF NOT EXISTS nippo.shift_entries (
  id                  serial      PRIMARY KEY,
  daily_report_id     integer     NOT NULL REFERENCES nippo.daily_reports(id) ON DELETE CASCADE,
  staff_id            integer     REFERENCES nippo.staff(id) ON DELETE SET NULL,
  staff_name_manual   text,
  entry_type          text        NOT NULL CHECK (entry_type IN ('plan','actual')),
  pattern             text        CHECK (pattern IN ('first','last','through')),
  start_time          time,
  end_time            time,
  break_minutes       integer     NOT NULL DEFAULT 0,
  break_start         time,
  break_end           time,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_entries_report_idx ON nippo.shift_entries (daily_report_id);

-- 2-6. order_lines
CREATE TABLE IF NOT EXISTS nippo.order_lines (
  id                  serial      PRIMARY KEY,
  daily_report_id     integer     NOT NULL REFERENCES nippo.daily_reports(id) ON DELETE CASCADE,
  product_id          integer     REFERENCES nippo.products(id) ON DELETE SET NULL,
  item_name_manual    text,
  planned_qty         integer     NOT NULL DEFAULT 0,
  actual_qty          integer     NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_lines_report_idx ON nippo.order_lines (daily_report_id);


-- ------------------------------------------------------------
-- 3. updated_at トリガ(全テーブル)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_stores_updated         ON nippo.stores;
DROP TRIGGER IF EXISTS trg_staff_updated          ON nippo.staff;
DROP TRIGGER IF EXISTS trg_products_updated       ON nippo.products;
DROP TRIGGER IF EXISTS trg_daily_reports_updated  ON nippo.daily_reports;
DROP TRIGGER IF EXISTS trg_shift_entries_updated  ON nippo.shift_entries;
DROP TRIGGER IF EXISTS trg_order_lines_updated    ON nippo.order_lines;

CREATE TRIGGER trg_stores_updated
  BEFORE UPDATE ON nippo.stores
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

CREATE TRIGGER trg_staff_updated
  BEFORE UPDATE ON nippo.staff
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

CREATE TRIGGER trg_products_updated
  BEFORE UPDATE ON nippo.products
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

CREATE TRIGGER trg_daily_reports_updated
  BEFORE UPDATE ON nippo.daily_reports
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

CREATE TRIGGER trg_shift_entries_updated
  BEFORE UPDATE ON nippo.shift_entries
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

CREATE TRIGGER trg_order_lines_updated
  BEFORE UPDATE ON nippo.order_lines
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();


-- ------------------------------------------------------------
-- 4. RLS は無効(Phase 1: 店舗画面は未認証アクセス運用)
-- ------------------------------------------------------------
-- Supabase Dashboard は RLS 未設定のテーブルに警告を出すため
-- 後から有効化されがちだが、現状の運用方針では無効が正しい。
-- 認証必須にする場合は別途ポリシーを設計してから有効化する。
ALTER TABLE nippo.stores         DISABLE ROW LEVEL SECURITY;
ALTER TABLE nippo.staff          DISABLE ROW LEVEL SECURITY;
ALTER TABLE nippo.products       DISABLE ROW LEVEL SECURITY;
ALTER TABLE nippo.daily_reports  DISABLE ROW LEVEL SECURITY;
ALTER TABLE nippo.shift_entries  DISABLE ROW LEVEL SECURITY;
ALTER TABLE nippo.order_lines    DISABLE ROW LEVEL SECURITY;


-- ============================================================
-- これでテーブル + トリガまで完成。
-- 次は 03_dump_runtime.sql の出力(View + RPC)を移行先で実行。
-- ============================================================

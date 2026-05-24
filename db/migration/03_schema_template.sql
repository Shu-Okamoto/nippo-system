-- ============================================================
-- 移行先(DXシステム側Supabase)で実行する nippo スキーマの DDL
-- ------------------------------------------------------------
-- このファイルは「コードから推測した」雛形です。
-- 必ず移行元の DB設計書_SQL一式.md / Supabase Dashboard の
-- "Definition" タブと突き合わせて、不足カラム・インデックス・
-- 制約・トリガを補ってから実行してください。
--
-- 実行順序: 01_target_init.sql → このファイル → RPC/View →
--           04_data_template.sql(データ)
-- ============================================================

SET search_path TO nippo, public;

-- ------------------------------------------------------------
-- 1. stores
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.stores (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL,
  slug        text        NOT NULL UNIQUE,
  open_time   time        NOT NULL,
  close_time  time        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true
);

-- ------------------------------------------------------------
-- 2. staff
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.staff (
  id          serial      PRIMARY KEY,
  store_id    integer     NOT NULL REFERENCES nippo.stores(id) ON DELETE RESTRICT,
  name        text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('head','part','support')),
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS staff_store_id_idx ON nippo.staff (store_id);

-- ------------------------------------------------------------
-- 3. products
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.products (
  id          serial      PRIMARY KEY,
  name        text        NOT NULL,
  category    text        NOT NULL,
  sort_order  integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true
);

-- ------------------------------------------------------------
-- 4. daily_reports
-- ------------------------------------------------------------
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

-- updated_at 自動更新トリガ(移行元と挙動を揃える想定)
CREATE OR REPLACE FUNCTION nippo.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daily_reports_set_updated_at ON nippo.daily_reports;
CREATE TRIGGER daily_reports_set_updated_at
BEFORE UPDATE ON nippo.daily_reports
FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

-- ------------------------------------------------------------
-- 5. shift_entries
-- ------------------------------------------------------------
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
  break_end           time
);
CREATE INDEX IF NOT EXISTS shift_entries_report_idx ON nippo.shift_entries (daily_report_id);

-- ------------------------------------------------------------
-- 6. order_lines
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.order_lines (
  id                  serial      PRIMARY KEY,
  daily_report_id     integer     NOT NULL REFERENCES nippo.daily_reports(id) ON DELETE CASCADE,
  product_id          integer     REFERENCES nippo.products(id) ON DELETE SET NULL,
  item_name_manual    text,
  planned_qty         integer     NOT NULL DEFAULT 0,
  actual_qty          integer     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS order_lines_report_idx ON nippo.order_lines (daily_report_id);

-- ============================================================
-- View / RPC は 02_dump_source.sql の出力を貼り付けてください。
-- View: nippo.daily_kpi
-- RPC : get_today_full / save_daily_report_full / add_product / get_orders_for_pdf
-- ============================================================

-- ------------------------------------------------------------
-- RLS(必要に応じて)
-- ------------------------------------------------------------
-- 移行元の pg_policies を確認した上で同じものを貼る。
-- Phase 1 では「店舗画面は未認証で読み書き可」「管理画面は要ログイン」運用。
-- 例:
-- ALTER TABLE nippo.stores ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "stores anon read" ON nippo.stores FOR SELECT TO anon USING (true);

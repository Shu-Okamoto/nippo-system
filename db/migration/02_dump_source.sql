-- ============================================================
-- 現行(移行元)Supabase で実行 → 出力されたDDLをコピーして
-- 移行先で実行する
-- ------------------------------------------------------------
-- 目的:
--   * 既存の public スキーマにある「ビュー」「関数(RPC)」の定義を
--     pg_get_*() で取り出す
--   * 出力結果の "public." を "nippo." に置換して 03_schema.sql に貼る
-- ------------------------------------------------------------
-- 注意:
--   * テーブル本体の CREATE TABLE 文は pg_get_tabledef が無いため
--     Dashboard → Database → Tables → 各テーブル → "Definition" タブ
--     から CREATE 文をコピーするのが確実(後述 MIGRATION.md 参照)。
--   * このスクリプトはビュー / 関数のみを対象にする。
-- ============================================================

-- --- 1) ビュー: daily_kpi ---
SELECT
  'CREATE OR REPLACE VIEW nippo.daily_kpi AS' || E'\n  ' ||
  replace(pg_get_viewdef('public.daily_kpi'::regclass, true), 'public.', 'nippo.')
  AS view_ddl;

-- --- 2) 関数(RPC): get_today_full / save_daily_report_full / add_product ---
SELECT
  replace(pg_get_functiondef(p.oid), 'public.', 'nippo.') AS function_ddl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_today_full',
    'save_daily_report_full',
    'add_product',
    'get_orders_for_pdf'
  )
ORDER BY p.proname;

-- --- 3) RLS ポリシー一覧(参考) ---
-- 移行先で同じ RLS を貼り直すかどうかを判断する材料
SELECT
  schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  )
ORDER BY tablename, policyname;

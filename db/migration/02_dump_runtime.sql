-- ============================================================
-- 現行(移行元)Supabase の SQL Editor で実行
-- ------------------------------------------------------------
-- 出力: 単一の "ddl_text" 列が複数行で返る。
--   行1   : nippo.daily_kpi の View 定義(CREATE OR REPLACE VIEW ...)
--   行2〜5: RPC 関数定義 4 本(get_today_full / save_daily_report_full /
--                              add_product / get_orders_for_pdf)
--
-- 使い方:
--   各行の "ddl_text" セルをクリック → 全文表示 → コピー
--   → 移行先 SQL Editor に貼って実行(順番は問わない、5回繰り返す)
-- ============================================================

SELECT ddl_text
FROM (
  -- (1) View: daily_kpi
  SELECT
    1 AS ord,
    'CRE' || 'ATE OR REPLACE VIEW nippo.daily_kpi AS' || chr(10) || '  ' ||
    replace(pg_get_viewdef('public.daily_kpi'::regclass, true), 'public.', 'nippo.')
    AS ddl_text

  UNION ALL

  -- (2) RPC 関数 4本
  SELECT
    2,
    replace(pg_get_functiondef(p.oid), 'public.', 'nippo.')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'get_today_full',
      'save_daily_report_full',
      'add_product',
      'get_orders_for_pdf'
    )
) x
ORDER BY ord;


-- ============================================================
-- (任意・参考用) 現行 RLS ポリシー一覧
-- ------------------------------------------------------------
-- 移行先で同じ RLS を貼り直すかは運用方針次第。必要なら下を
-- コメントアウト解除して実行 → 内容を確認 → ポリシー定義を手で写す。
-- ============================================================
-- SELECT schemaname, tablename, policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'stores','staff','products',
--     'daily_reports','shift_entries','order_lines'
--   )
-- ORDER BY tablename, policyname;

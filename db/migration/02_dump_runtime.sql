-- ============================================================
-- 現行(移行元)Supabase の SQL Editor で実行
-- ------------------------------------------------------------
-- 出力: 単一の "ddl_text" 列が複数行で返る。
--   行1 〜 N : public スキーマのユーザー定義関数を全部ダンプ
--              (set_updated_at / shift_minutes / 各RPC等を含む)
--   行 N+1   : nippo.daily_kpi の View 定義(関数の後に来るのは
--              ビューが関数を参照しているため必須)
--
-- 使い方:
--   各行の "ddl_text" セルをクリック → 全文表示 → コピー
--   → 移行先 SQL Editor に貼って実行
--   → 全行分繰り返す(行番号 ord の昇順、つまり「関数 → View」の順)
-- ============================================================

SELECT ddl_text
FROM (
  -- (1) public スキーマの plpgsql / sql 関数を全部
  --     set_updated_at, shift_minutes, get_today_full,
  --     save_daily_report_full, add_product, get_orders_for_pdf 等
  SELECT
    row_number() OVER (ORDER BY p.proname) AS ord,
    'SET search_path TO nippo, public;' || chr(10) || chr(10) ||
    replace(pg_get_functiondef(p.oid), 'public.', 'nippo.')
    AS ddl_text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND l.lanname IN ('plpgsql', 'sql')

  UNION ALL

  -- (2) View: daily_kpi
  --     関数の後に作成(daily_kpi は shift_minutes を参照しているため)
  SELECT
    1000 AS ord,
    'SET search_path TO nippo, public;' || chr(10) || chr(10) ||
    'CRE' || 'ATE OR REPLACE VIEW nippo.daily_kpi AS' || chr(10) || '  ' ||
    replace(pg_get_viewdef('public.daily_kpi'::regclass, true), 'public.', 'nippo.')
    AS ddl_text
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

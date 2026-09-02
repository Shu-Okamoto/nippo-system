-- ============================================================
-- RLS を有効化する
-- ------------------------------------------------------------
-- Supabase の警告:
--   "Table nippo.stores is public, but RLS has not been enabled."
--
-- Phase 1 は「未認証アクセス前提」で RLS を切っていたが、その後
-- 勤怠打刻(労務記録)・売上・時給・PIN を持つようになったため、
-- anon キー(ブラウザに配られる)で何でも読み書きできる状態は危険。
--
-- ただし店舗画面は未認証で動く必要があるので、一律に閉じることは
-- できない。実際のアクセス経路を調べたうえで2段階に分ける。
--
-- 【方針】
--   Tier 1 完全遮断  … クライアントが直接触っていないテーブル。
--                      すべて SECURITY DEFINER の RPC 経由なので
--                      閉じても何も壊れない
--   Tier 2 読み取りのみ … 店舗画面(未認証)が直接読むテーブル。
--                      書き込みはログイン済みのみに制限する。
--                      未認証からの書き込みは従来どおり RPC 経由
--
-- SECURITY DEFINER の関数は所有者(postgres)権限で動くため RLS を
-- 迂回する。既存の RPC はすべてそのまま動作する。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================


-- ------------------------------------------------------------
-- (0) 移行初期に作られた古いポリシーを掃除する
--     テーブルに RLS が無い状態で残っていた可能性がある
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "anon read" ON nippo.stores;
DROP POLICY IF EXISTS "anon read" ON nippo.staff;
DROP POLICY IF EXISTS "anon read" ON nippo.products;


-- ============================================================
-- Tier 1: 完全遮断(RPC 経由のみ)
-- ------------------------------------------------------------
-- ポリシーを1つも作らない = anon / authenticated からは
-- 直接 SELECT も INSERT もできない。
-- service_role と SECURITY DEFINER の関数だけが到達できる。
-- ============================================================

-- 勤怠打刻。労務記録そのものなので最も守る必要がある。
-- 画面は get_punch_events / get_clock_board などの RPC 経由で読んでおり、
-- 直接読んでいるのはサーバ側の API ルート(service role)のみ
ALTER TABLE nippo.time_clock_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tce_all ON nippo.time_clock_events;

-- PIN ハッシュと時給。ここが漏れると 4〜6桁の PIN は総当たりされる
ALTER TABLE nippo.staff_private ENABLE ROW LEVEL SECURITY;

-- freee の OAuth トークン
ALTER TABLE nippo.freee_tokens ENABLE ROW LEVEL SECURITY;

-- 全体設定。読み取りは get_app_settings() 経由
ALTER TABLE nippo.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_read ON nippo.app_settings;


-- ============================================================
-- Tier 2: 未認証は読み取りのみ、書き込みはログイン済みのみ
-- ------------------------------------------------------------
-- 店舗の日報画面・打刻画面・公開ダッシュボードが未認証で
-- これらを直接読んでいるため、SELECT は anon にも許可する。
--
-- 一方、未認証からの書き込みは RPC(save_daily_report_full 等)
-- 経由なので、テーブルへの直接書き込みは閉じてよい。
-- これで「anon キーを持っていれば全データを消せる」状態が無くなる。
-- ============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores', 'staff', 'products', 'report_questions',
    'daily_reports', 'shift_entries', 'order_lines', 'report_answers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE nippo.%I ENABLE ROW LEVEL SECURITY;', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON nippo.%I;', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON nippo.%I;', t || '_write', t);

    -- 誰でも読める(店舗画面が未認証で動くため)
    EXECUTE format(
      'CREATE POLICY %I ON nippo.%I FOR SELECT TO anon, authenticated USING (true);',
      t || '_select', t
    );

    -- 書き込みはログイン済みのみ。未認証は RPC 経由でしか書けない
    EXECUTE format(
      'CREATE POLICY %I ON nippo.%I FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      t || '_write', t
    );
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- 確認クエリ
-- ------------------------------------------------------------
-- RLS の有効状態を一覧する
--
-- SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
--        (SELECT count(*) FROM pg_policies p
--         WHERE p.schemaname = 'nippo' AND p.tablename = c.relname) AS policies
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'nippo' AND c.relkind = 'r'
-- ORDER BY c.relname;
--
-- 期待する結果:
--   app_settings        t  0   ← Tier 1(ポリシー無し = 遮断)
--   daily_reports       t  2   ← Tier 2
--   freee_tokens        t  0
--   order_lines         t  2
--   products            t  2
--   report_answers      t  2
--   report_questions    t  2
--   shift_entries       t  2
--   staff               t  2
--   staff_private       t  0
--   stores              t  2
--   time_clock_events   t  0

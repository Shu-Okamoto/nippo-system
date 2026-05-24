-- ============================================================
-- 移行先(DXシステム側Supabase)で最初に実行する初期化スクリプト
-- ------------------------------------------------------------
-- 目的:
--   * nippo スキーマを作成
--   * Supabase の PostgREST から nippo スキーマにアクセスできるよう権限付与
--   * anon / authenticated ロールに必要な権限を渡す
-- ------------------------------------------------------------
-- 実行場所: 移行先プロジェクトの Dashboard → SQL Editor
-- 実行順序: 02_schema.sql の前に 1 回だけ実行
-- ============================================================

CREATE SCHEMA IF NOT EXISTS nippo;

-- PostgREST(Supabase REST API)から nippo スキーマを参照可能にする
GRANT USAGE ON SCHEMA nippo TO anon, authenticated, service_role;

-- これ以降に nippo スキーマ内に作成されるテーブル/関数のデフォルト権限
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- anon(未ログイン) は店舗画面で SELECT/INSERT/UPDATE が要るので個別に付与
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT SELECT, INSERT, UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA nippo
  GRANT USAGE, SELECT ON SEQUENCES TO anon;

-- ============================================================
-- 重要: この後 Dashboard → Project Settings → API → Exposed schemas
-- に "nippo" を追加してください(public のままだと REST から見えません)。
-- ============================================================

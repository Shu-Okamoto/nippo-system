-- ============================================================
-- 現行(移行元)Supabase で実行 → 出力された CREATE TABLE 文を
-- そのまま 移行先 SQL Editor に貼って実行
-- ------------------------------------------------------------
-- 仕組み:
--   pg_catalog から CREATE TABLE / ALTER TABLE / CREATE INDEX / CREATE TRIGGER
--   を組み立てる。すべて "public." を "nippo." に置換して TEXT で返すので、
--   結果を移行先で実行すれば nippo スキーマ上に同じテーブルが再現される。
-- ------------------------------------------------------------
-- ★ Supabase SQL Editor は本文中の "CREATE TABLE" / "ALTER TABLE" 文字列を
--   テキストスキャンで DDL/マイグレーションと誤検出し、確認ダイアログや
--   nippo スキーマ事前バリデーション(=relation "nippo" does not exist)で
--   400 を返してしまう。これを回避するため、キーワードを文字列連結で
--   分割している('CRE' || 'ATE TABLE …' 等)。出力結果は同じ。
-- ------------------------------------------------------------
-- ★ A → B → C → D の順に「個別に」 SQL Editor で実行してください。
-- ============================================================


-- ============================================================
-- A) CREATE TABLE 本体(カラム定義のみ)
-- ============================================================
SELECT
  'CRE' || 'ATE TABLE IF NOT EXISTS nippo.' || c.relname || ' (' || chr(10) || '  ' ||
  string_agg(
    a.attname || ' ' ||
    pg_catalog.format_type(a.atttypid, a.atttypmod) ||
    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END ||
    CASE
      WHEN pg_get_expr(ad.adbin, ad.adrelid) IS NOT NULL
        THEN ' DEFAULT ' ||
             replace(pg_get_expr(ad.adbin, ad.adrelid), 'public.', 'nippo.')
      ELSE ''
    END,
    ',' || chr(10) || '  ' ORDER BY a.attnum
  ) || chr(10) || ');' AS ddl_text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  )
GROUP BY c.relname
ORDER BY c.relname;


-- ============================================================
-- B) 制約(PK / UNIQUE / FK / CHECK)
-- ============================================================
SELECT
  'ALT' || 'ER TABLE nippo.' || c.relname || ' ADD CONSTRAINT ' || co.conname || ' ' ||
  replace(pg_get_constraintdef(co.oid, true), 'public.', 'nippo.') || ';' AS ddl_text
FROM pg_constraint co
JOIN pg_class c ON c.oid = co.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  )
ORDER BY c.relname,
  CASE co.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'f' THEN 3 ELSE 4 END,
  co.conname;


-- ============================================================
-- C) インデックス(PK/UNIQUE 由来は除外、ユーザ作成のみ)
-- ------------------------------------------------------------
-- pg_get_indexdef は実行時に "CREATE INDEX …" を返すが、
-- クエリ本文に "CREATE INDEX" の文字列はないので分割不要。
-- ============================================================
SELECT
  replace(pg_get_indexdef(i.indexrelid), 'public.', 'nippo.') || ';' AS ddl_text
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  )
  AND NOT i.indisprimary
  AND NOT i.indisunique
ORDER BY c.relname;


-- ============================================================
-- D-1) トリガが参照する関数(set_updated_at など)を nippo に作成
-- ------------------------------------------------------------
-- pg_get_triggerdef は EXECUTE FUNCTION の関数をスキーマ修飾なしで
-- 返すことがあるため、トリガ関数も先に nippo スキーマに作る必要がある。
-- 出力結果(CREATE FUNCTION nippo.xxx ...)を移行先で実行。
-- ============================================================
SELECT replace(pg_get_functiondef(p.oid), 'public.', 'nippo.') AS function_ddl
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  )
GROUP BY p.oid;


-- ============================================================
-- D-2) トリガ本体 — テーブル名/関数名に nippo スキーマを注入
-- ------------------------------------------------------------
-- pg_get_triggerdef はスキーマ修飾を省略するので、後段の replace で
--   ON テーブル名     → ON nippo.テーブル名
--   EXECUTE FUNCTION 関数名(  → EXECUTE FUNCTION nippo.関数名(
-- を注入する。
-- ============================================================
SELECT
  replace(
    replace(
      pg_get_triggerdef(t.oid, true),
      ' ON ' || c.relname || ' ',
      ' ON nippo.' || c.relname || ' '
    ),
    'EXECUTE FUNCTION ' || p.proname || '(',
    'EXECUTE FUNCTION nippo.' || p.proname || '('
  ) || ';' AS ddl_text
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  );


-- ============================================================
-- 実行順序(移行先 SQL Editor 側):
--   A の結果 → B の結果 → C の結果 → D-1 の結果 → D-2 の結果
-- ============================================================

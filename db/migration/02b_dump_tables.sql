-- ============================================================
-- 現行(移行元)Supabase で実行 → 出力された CREATE TABLE 文を
-- そのまま 移行先 SQL Editor に貼って実行
-- ------------------------------------------------------------
-- 仕組み:
--   pg_catalog から CREATE TABLE / ALTER TABLE / CREATE INDEX を組み立てる。
--   すべて "public." を "nippo." に置換して TEXT で返すので、結果を
--   そのまま移行先で実行すれば nippo スキーマ上に同じテーブルが再現される。
-- ------------------------------------------------------------
-- ★ 3 セクションに分解しているので、A → B → C の順に「個別に」
--   SQL Editor で実行してください(まとめて貼ると Supabase のエディタが
--   1 トランザクションとして扱う関係で、原因の切り分けが難しくなります)。
-- ============================================================


-- ============================================================
-- A) CREATE TABLE 本体(カラム定義のみ)
-- ============================================================
SELECT
  'CREATE TABLE IF NOT EXISTS nippo.' || c.relname || ' (' || E'\n  ' ||
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
    ',' || E'\n  ' ORDER BY a.attnum
  ) || E'\n);' AS sql
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
  'ALTER TABLE nippo.' || c.relname || ' ADD CONSTRAINT ' || co.conname || ' ' ||
  replace(pg_get_constraintdef(co.oid, true), 'public.', 'nippo.') || ';' AS sql
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
-- ============================================================
SELECT
  replace(pg_get_indexdef(i.indexrelid), 'public.', 'nippo.') || ';' AS sql
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
-- D) (任意)トリガ
-- ============================================================
SELECT
  replace(pg_get_triggerdef(t.oid, true), 'public.', 'nippo.') || ';' AS sql
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname IN (
    'stores','staff','products',
    'daily_reports','shift_entries','order_lines'
  );


-- ============================================================
-- 実行順序(移行先 SQL Editor 側):
--   A の結果 → B の結果 → C の結果 → D の結果
--   (B/C は無くても A だけで起動はする。順序は必ず A 先行。)
-- ============================================================

-- ============================================================
-- 現行(移行元)Supabase で実行 → 出力された CREATE TABLE 文を
-- そのまま 移行先 SQL Editor に貼って実行
-- ------------------------------------------------------------
-- 仕組み:
--   information_schema / pg_catalog から CREATE TABLE 文を組み立てる。
--   * カラム定義(型, NOT NULL, DEFAULT)
--   * 制約(PK / UNIQUE / FK / CHECK)
--   * インデックス
--   いずれも "public." を "nippo." に置換して出力するので、結果を
--   そのまま移行先 SQL Editor に貼れば nippo スキーマ上に同じ
--   テーブルが再現される。
-- ------------------------------------------------------------
-- これを実行すれば 03_schema_template.sql は不要(雛形ではなく本物が出る)。
-- ============================================================

WITH target_tables(name) AS (
  VALUES
    ('stores'),
    ('staff'),
    ('products'),
    ('daily_reports'),
    ('shift_entries'),
    ('order_lines')
),
-- 1) CREATE TABLE 本体(カラムのみ)
table_ddl AS (
  SELECT
    c.relname AS tbl,
    'CREATE TABLE IF NOT EXISTS nippo.' || quote_ident(c.relname) || ' (' || E'\n' ||
    string_agg(
      '  ' || quote_ident(a.attname) || ' ' ||
      pg_catalog.format_type(a.atttypid, a.atttypmod) ||
      CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END ||
      CASE
        WHEN ad.adbin IS NOT NULL
          THEN ' DEFAULT ' ||
               replace(pg_get_expr(ad.adbin, ad.adrelid), 'public.', 'nippo.')
        ELSE ''
      END,
      E',\n' ORDER BY a.attnum
    ) || E'\n);' AS ddl
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN target_tables tt ON tt.name = c.relname
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  GROUP BY c.relname
),
-- 2) 制約(PK / UNIQUE / CHECK / FK)を ALTER TABLE で追加
constraint_ddl AS (
  SELECT
    c.relname AS tbl,
    'ALTER TABLE nippo.' || quote_ident(c.relname) || ' ADD CONSTRAINT ' ||
    quote_ident(co.conname) || ' ' ||
    replace(pg_get_constraintdef(co.oid, true), 'public.', 'nippo.') || ';' AS ddl
  FROM pg_constraint co
  JOIN pg_class c ON c.oid = co.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN target_tables tt ON tt.name = c.relname
  WHERE n.nspname = 'public'
),
-- 3) インデックス(PK/UNIQUE 制約由来は除外、ユーザ作成のものだけ)
index_ddl AS (
  SELECT
    c.relname AS tbl,
    replace(pg_get_indexdef(i.indexrelid), 'public.', 'nippo.') || ';' AS ddl
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN target_tables tt ON tt.name = c.relname
  WHERE n.nspname = 'public'
    AND NOT i.indisprimary
    AND NOT i.indisunique
)
-- 全部を1セットで出力(順序: テーブル定義 → 制約 → インデックス)
SELECT 1 AS ord, tbl, ddl FROM table_ddl
UNION ALL
SELECT 2, tbl, ddl FROM constraint_ddl
UNION ALL
SELECT 3, tbl, ddl FROM index_ddl
ORDER BY ord, tbl;

-- ============================================================
-- 補足:
-- * トリガ(updated_at 自動更新など)が現行にある場合は別途取得が必要。
--   下記のクエリで定義を取り出せる:
--
--   SELECT
--     replace(pg_get_triggerdef(t.oid, true), 'public.', 'nippo.') || ';' AS ddl
--   FROM pg_trigger t
--   JOIN pg_class c ON c.oid = t.tgrelid
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND NOT t.tgisinternal
--     AND c.relname IN ('stores','staff','products',
--                       'daily_reports','shift_entries','order_lines');
--
--   トリガが参照する関数は 02_dump_source.sql の関数ダンプ側で拾えるので、
--   そちらの WHERE 句に関数名を追加してください。
-- ============================================================

-- ============================================================
-- 現行(移行元)Supabase で実行 → 出力を全選択コピー →
-- 移行先 SQL Editor で実行(nippo スキーマに対する INSERT)
-- ------------------------------------------------------------
-- 仕組み:
--   各テーブルから format(...) で「INSERT INTO nippo.xxx (...) VALUES (...);」
--   形式の文字列を生成する。NULL 値や引用符は %L で安全にエスケープされる。
--
-- 実行順序(参照整合性の都合上):
--   1. stores
--   2. staff
--   3. products
--   4. daily_reports
--   5. shift_entries
--   6. order_lines
--   7. setval(各シーケンスをずらす — id 衝突防止)
-- ------------------------------------------------------------
-- 出力結果のうち最終行に "BEGIN; ... COMMIT;" を自分でラップすると安全。
-- ============================================================

-- ============ 1) stores ============
SELECT format(
  'INSERT INTO nippo.stores (id, name, slug, open_time, close_time, is_active) VALUES (%L, %L, %L, %L, %L, %L);',
  id, name, slug, open_time, close_time, is_active
) AS sql
FROM public.stores
ORDER BY id;

-- ============ 2) staff ============
SELECT format(
  'INSERT INTO nippo.staff (id, store_id, name, role, sort_order, is_active) VALUES (%L, %L, %L, %L, %L, %L);',
  id, store_id, name, role, sort_order, is_active
) AS sql
FROM public.staff
ORDER BY id;

-- ============ 3) products ============
SELECT format(
  'INSERT INTO nippo.products (id, name, category, sort_order, is_active) VALUES (%L, %L, %L, %L, %L);',
  id, name, category, sort_order, is_active
) AS sql
FROM public.products
ORDER BY id;

-- ============ 4) daily_reports ============
SELECT format(
  'INSERT INTO nippo.daily_reports (id, store_id, report_date, weather, event_note, sales_forecast, sales_actual, customer_count, sozai_zan, mochi_zan, report_text, kizuki, bikou, updated_at) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L);',
  id, store_id, report_date, weather, event_note,
  sales_forecast, sales_actual, customer_count,
  sozai_zan, mochi_zan, report_text, kizuki, bikou,
  updated_at
) AS sql
FROM public.daily_reports
ORDER BY id;

-- ============ 5) shift_entries ============
SELECT format(
  'INSERT INTO nippo.shift_entries (id, daily_report_id, staff_id, staff_name_manual, entry_type, pattern, start_time, end_time, break_minutes, break_start, break_end) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L);',
  id, daily_report_id, staff_id, staff_name_manual,
  entry_type, pattern, start_time, end_time,
  break_minutes, break_start, break_end
) AS sql
FROM public.shift_entries
ORDER BY id;

-- ============ 6) order_lines ============
SELECT format(
  'INSERT INTO nippo.order_lines (id, daily_report_id, product_id, item_name_manual, planned_qty, actual_qty) VALUES (%L, %L, %L, %L, %L, %L);',
  id, daily_report_id, product_id, item_name_manual,
  planned_qty, actual_qty
) AS sql
FROM public.order_lines
ORDER BY id;

-- ============ 7) シーケンス補正 ============
-- 移行先で id 自動採番が既存最大値とぶつからないようにする。
-- 下記6行は出力結果としてコピーして、移行先で実行。
SELECT format(
  'SELECT setval(pg_get_serial_sequence(''nippo.%I'', ''id''), (SELECT COALESCE(MAX(id), 0) + 1 FROM nippo.%I), false);',
  t, t
) AS sql
FROM (VALUES
  ('stores'),('staff'),('products'),
  ('daily_reports'),('shift_entries'),('order_lines')
) AS x(t);

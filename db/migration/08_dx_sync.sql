-- ============================================================
-- 売上系の同期漏れ修正(daily_reports.sales_actual/customer_count/
-- weather を dx."Sale" から再同期)
-- ------------------------------------------------------------
-- 背景:
--   save_daily_report_full は CURRENT_DATE 時点の dx."Sale" を読んで
--   daily_reports に snapshot 保存する設計。dx."Sale" が後から
--   更新された場合、daily_reports に反映されない。
--
-- 対策:
--   (A) 全期間 全店舗で過去分を一括バックフィル
--   (B) 日付指定で再同期する RPC を追加(ダッシュボード読込時に呼び出す)
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================

-- (A) 全期間バックフィル
UPDATE nippo.daily_reports dr
SET sales_actual   = ds.amount::int,
    customer_count = ds."customerCount",
    weather        = ds.weather
FROM dx."Sale" ds, nippo.stores s
WHERE dr.store_id = s.id
  AND ds."saleDate" = dr.report_date
  AND ds."storeId" = (CASE s.slug WHEN 'nishi' THEN 1 WHEN 'minami' THEN 2 ELSE NULL END);


-- (B) 同期 RPC
CREATE OR REPLACE FUNCTION nippo.sync_dx_for_date(p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, dx, public
AS $func$
BEGIN
  UPDATE nippo.daily_reports dr
  SET sales_actual   = ds.amount::int,
      customer_count = ds."customerCount",
      weather        = ds.weather
  FROM dx."Sale" ds, nippo.stores s
  WHERE dr.store_id = s.id
    AND dr.report_date = p_date
    AND ds."saleDate"  = p_date
    AND ds."storeId" = (CASE s.slug WHEN 'nishi' THEN 1 WHEN 'minami' THEN 2 ELSE NULL END);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.sync_dx_for_date(date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

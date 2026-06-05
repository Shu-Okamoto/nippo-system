-- ============================================================
-- 惣菜残(sozai_zan) / 餅残(mochi_zan) を integer → text に変更
-- ------------------------------------------------------------
-- ※ 列型を変えるので、それを引数に取っている
--    save_daily_report_full RPC も併せて作り直す。
--    移行先(DX側) SQL Editor で1回実行。
-- ============================================================

-- (1) 列型を text に変更(既存の数値はそのまま文字列表現に変換)
ALTER TABLE nippo.daily_reports
  ALTER COLUMN sozai_zan TYPE text USING sozai_zan::text;
ALTER TABLE nippo.daily_reports
  ALTER COLUMN mochi_zan TYPE text USING mochi_zan::text;


-- (2) 旧 save_daily_report_full を削除
--    (引数 sozai_zan/mochi_zan の型が変わるため上書きできない)
DROP FUNCTION IF EXISTS nippo.save_daily_report_full(
  text, text, text,
  integer, integer, integer, integer, integer,
  text, text, text,
  jsonb, jsonb
);


-- (3) 新 save_daily_report_full を作成
CREATE OR REPLACE FUNCTION nippo.save_daily_report_full(
  p_slug           text,
  p_weather        text     DEFAULT NULL,
  p_event_note     text     DEFAULT NULL,
  p_sales_forecast integer  DEFAULT NULL,
  p_sales_actual   integer  DEFAULT NULL,
  p_customer_count integer  DEFAULT NULL,
  p_sozai_zan      text     DEFAULT NULL,
  p_mochi_zan      text     DEFAULT NULL,
  p_report_text    text     DEFAULT NULL,
  p_kizuki         text     DEFAULT NULL,
  p_bikou          text     DEFAULT NULL,
  p_shifts         jsonb    DEFAULT '[]'::jsonb,
  p_orders         jsonb    DEFAULT '[]'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id   int;
  v_report_id  int;
  v_today      date := CURRENT_DATE;
  v_shift      jsonb;
  v_order      jsonb;
BEGIN
  -- 店舗特定
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  -- daily_reports を upsert
  INSERT INTO nippo.daily_reports (
    store_id, report_date, weather, event_note,
    sales_forecast, sales_actual, customer_count,
    sozai_zan, mochi_zan,
    report_text, kizuki, bikou
  ) VALUES (
    v_store_id, v_today, p_weather, p_event_note,
    p_sales_forecast, p_sales_actual, p_customer_count,
    p_sozai_zan, p_mochi_zan,
    p_report_text, p_kizuki, p_bikou
  )
  ON CONFLICT (store_id, report_date) DO UPDATE SET
    weather        = EXCLUDED.weather,
    event_note     = EXCLUDED.event_note,
    sales_forecast = EXCLUDED.sales_forecast,
    sales_actual   = EXCLUDED.sales_actual,
    customer_count = EXCLUDED.customer_count,
    sozai_zan      = EXCLUDED.sozai_zan,
    mochi_zan      = EXCLUDED.mochi_zan,
    report_text    = EXCLUDED.report_text,
    kizuki         = EXCLUDED.kizuki,
    bikou          = EXCLUDED.bikou
  RETURNING id INTO v_report_id;

  -- シフトを全置換
  DELETE FROM nippo.shift_entries WHERE daily_report_id = v_report_id;
  FOR v_shift IN SELECT * FROM jsonb_array_elements(p_shifts)
  LOOP
    INSERT INTO nippo.shift_entries (
      daily_report_id, staff_id, staff_name_manual,
      entry_type, pattern,
      start_time, end_time,
      break_minutes, break_start, break_end
    ) VALUES (
      v_report_id,
      NULLIF(v_shift->>'staff_id', '')::int,
      v_shift->>'staff_name_manual',
      v_shift->>'entry_type',
      v_shift->>'pattern',
      NULLIF(v_shift->>'start_time', '')::time,
      NULLIF(v_shift->>'end_time', '')::time,
      COALESCE(NULLIF(v_shift->>'break_minutes','')::int, 0),
      NULLIF(v_shift->>'break_start', '')::time,
      NULLIF(v_shift->>'break_end', '')::time
    );
  END LOOP;

  -- 注文を全置換
  DELETE FROM nippo.order_lines WHERE daily_report_id = v_report_id;
  FOR v_order IN SELECT * FROM jsonb_array_elements(p_orders)
  LOOP
    INSERT INTO nippo.order_lines (
      daily_report_id, product_id, item_name_manual, planned_qty
    ) VALUES (
      v_report_id,
      NULLIF(v_order->>'product_id', '')::int,
      v_order->>'item_name_manual',
      COALESCE(NULLIF(v_order->>'planned_qty','')::int, 0)
    );
  END LOOP;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.save_daily_report_full(
  text, text, text, integer, integer, integer,
  text, text, text, text, text, jsonb, jsonb
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 過去日報の編集を可能にする RPC を追加
-- ------------------------------------------------------------
-- ・get_report_full(p_slug, p_date)  … 任意日付の日報を一括取得
-- ・save_report_full(...)            … 任意日付の日報を一括保存
--   (weather/sales/customer_count は dx.sale を再フェッチせず、
--    フロントから渡された値をそのまま保存 = 既存値の維持または明示更新)
--
-- 既存の get_today_full / save_daily_report_full には手を入れない。
-- スタッフ画面(/today)は今日限定のまま。
-- 管理画面(/admin/edit/[slug]/[date])からこの新 RPC を叩く。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================


-- (1) get_report_full: 任意日付の日報 + シフト + 注文を一括取得
CREATE OR REPLACE FUNCTION nippo.get_report_full(
  p_slug text,
  p_date date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id  int;
  v_report_id int;
  v_report    jsonb;
  v_shifts    jsonb;
  v_orders    jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  SELECT to_jsonb(r), r.id
    INTO v_report, v_report_id
  FROM nippo.daily_reports r
  WHERE r.store_id = v_store_id
    AND r.report_date = p_date;

  IF v_report_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_report', false,
      'report',     NULL,
      'shifts',     '[]'::jsonb,
      'orders',     '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
    INTO v_shifts
  FROM nippo.shift_entries s
  WHERE s.daily_report_id = v_report_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb)
    INTO v_orders
  FROM nippo.order_lines o
  WHERE o.daily_report_id = v_report_id;

  RETURN jsonb_build_object(
    'has_report', true,
    'report',     v_report,
    'shifts',     v_shifts,
    'orders',     v_orders
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_report_full(text, date)
  TO anon, authenticated, service_role;


-- (2) save_report_full: 任意日付の日報を一括保存
--     save_daily_report_full と同じ挙動だが、日付とすべての集計値を
--     引数で受け取り、dx.sale の再フェッチはしない。
DROP FUNCTION IF EXISTS nippo.save_report_full(
  text, date, text, text, integer, integer, integer,
  text, text, text, text, text, jsonb, jsonb, jsonb
);

CREATE OR REPLACE FUNCTION nippo.save_report_full(
  p_slug           text,
  p_date           date,
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
  p_orders         jsonb    DEFAULT '[]'::jsonb,
  p_answers        jsonb    DEFAULT '[]'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id   int;
  v_report_id  int;
  v_shift      jsonb;
  v_order      jsonb;
  v_answer     jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  INSERT INTO nippo.daily_reports (
    store_id, report_date, weather, event_note,
    sales_forecast, sales_actual, customer_count,
    sozai_zan, mochi_zan,
    report_text, kizuki, bikou
  ) VALUES (
    v_store_id, p_date, p_weather, p_event_note,
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

  FOR v_answer IN SELECT * FROM jsonb_array_elements(p_answers)
  LOOP
    INSERT INTO nippo.report_answers (daily_report_id, question_id, answer_text)
    VALUES (
      v_report_id,
      (v_answer->>'question_id')::int,
      v_answer->>'answer_text'
    )
    ON CONFLICT (daily_report_id, question_id) DO UPDATE SET
      answer_text = EXCLUDED.answer_text;
  END LOOP;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.save_report_full(
  text, date, text, text, integer, integer, integer,
  text, text, text, text, text, jsonb, jsonb, jsonb
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

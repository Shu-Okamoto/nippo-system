-- ============================================================
-- nippo.get_dx_sales(p_store_slug, p_today)
-- ------------------------------------------------------------
-- dx."Sale" から以下を返す RPC(SECURITY DEFINER):
--   * forecast      : 前年同日付の前後で一番近い同曜日の売上 (numeric)
--   * actual        : 当日の売上                              (numeric)
--   * customer_count: 当日の客数                              (int)
--   * weather       : 当日の天気                              (text)
-- いずれもデータが無ければ null。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================

CREATE OR REPLACE FUNCTION nippo.get_dx_sales(
  p_store_slug text,
  p_today      date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, dx, public
AS $func$
DECLARE
  v_store_id        int;
  v_target          date;
  v_offset          int;
  v_prev_year_date  date;
  v_forecast        numeric;
  v_actual          numeric;
  v_customer_count  int;
  v_weather         text;
BEGIN
  -- slug → dx."Sale"."storeId" のマッピング(ハードコード)
  v_store_id := CASE p_store_slug
    WHEN 'nishi'  THEN 1
    WHEN 'minami' THEN 2
    ELSE NULL
  END;

  IF v_store_id IS NULL THEN
    RETURN jsonb_build_object(
      'forecast',       NULL,
      'actual',         NULL,
      'customer_count', NULL,
      'weather',        NULL
    );
  END IF;

  -- 「前年同日付の前後で一番近い同曜日」を計算
  v_target := p_today - INTERVAL '1 year';
  v_offset := (EXTRACT(DOW FROM p_today)::int
               - EXTRACT(DOW FROM v_target)::int + 7) % 7;     -- 0..6
  IF v_offset > 3 THEN
    v_offset := v_offset - 7;                                  -- -3..3
  END IF;
  v_prev_year_date := v_target + (v_offset || ' days')::interval;

  -- 前年同曜日の売上
  SELECT amount INTO v_forecast
  FROM dx."Sale"
  WHERE "storeId"  = v_store_id
    AND "saleDate" = v_prev_year_date;

  -- 当日の売上 + 客数 + 天気
  SELECT amount, "customerCount", weather
    INTO v_actual, v_customer_count, v_weather
  FROM dx."Sale"
  WHERE "storeId"  = v_store_id
    AND "saleDate" = p_today;

  RETURN jsonb_build_object(
    'forecast',       v_forecast,
    'actual',         v_actual,
    'customer_count', v_customer_count,
    'weather',        v_weather
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_dx_sales(text, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

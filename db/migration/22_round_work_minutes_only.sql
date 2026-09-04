-- ============================================================
-- 15分丸めを「実働時間の計算」だけに限定する
-- ------------------------------------------------------------
-- 21_quarter_hour_rounding.sql では出勤・退勤時刻の表示まで丸めて
-- いたが、正しくは次のとおり:
--
--   出勤時刻 … 打刻したそのままを表示   (09:01 なら 09:01)
--   退勤時刻 … 打刻したそのままを表示   (17:14 なら 17:14)
--   休憩時間 … 実際の分数をそのまま表示 (47分なら 47分)
--   実働時間 … ここでだけ丸める
--                出勤を切り上げ / 退勤を切り捨て / 休憩を切り上げ
--
-- 例: 09:01 出勤・17:14 退勤・休憩47分
--       表示は 09:01 / 17:14 / 47分
--       実働は 09:15〜17:00 から 60分を引いて 6.75h
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 21_quarter_hour_rounding.sql 実行済み
-- ============================================================

CREATE OR REPLACE FUNCTION nippo.clock_summary(
  p_staff_id  integer,
  p_work_date date
) RETURNS TABLE (
  start_time    time,
  end_time      time,
  break_minutes integer,
  work_minutes  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_start     time;
  v_end       time;
  v_break     int := 0;
  v_start_min int;
  v_end_min   int;
  v_break_min int;
BEGIN
  SELECT min((event_at AT TIME ZONE 'Asia/Tokyo')::time)
    INTO v_start
  FROM nippo.time_clock_events
  WHERE staff_id = p_staff_id AND work_date = p_work_date
    AND event_type = 'clock_in' AND NOT is_voided;

  SELECT max((event_at AT TIME ZONE 'Asia/Tokyo')::time)
    INTO v_end
  FROM nippo.time_clock_events
  WHERE staff_id = p_staff_id AND work_date = p_work_date
    AND event_type = 'clock_out' AND NOT is_voided;

  -- 休憩は break_begin と直後の break_end をペアにして合計する
  WITH ev AS (
    SELECT event_type, event_at,
           lead(event_type) OVER (ORDER BY event_at, id) AS next_type,
           lead(event_at)   OVER (ORDER BY event_at, id) AS next_at
    FROM nippo.time_clock_events
    WHERE staff_id = p_staff_id AND work_date = p_work_date
      AND event_type IN ('break_begin','break_end') AND NOT is_voided
  )
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (next_at - event_at)) / 60)::int, 0)
    INTO v_break
  FROM ev
  WHERE event_type = 'break_begin' AND next_type = 'break_end';

  -- ここから先は実働の計算専用。表示用の値には反映しない
  IF v_start IS NOT NULL THEN
    v_start_min := CEIL(
      (EXTRACT(HOUR FROM v_start) * 60 + EXTRACT(MINUTE FROM v_start))::numeric / 15
    )::int * 15;
  END IF;

  IF v_end IS NOT NULL THEN
    v_end_min := FLOOR(
      (EXTRACT(HOUR FROM v_end) * 60 + EXTRACT(MINUTE FROM v_end))::numeric / 15
    )::int * 15;
  END IF;

  -- 休憩0分は切り上げない(休憩を取っていない日を15分にしないため)
  v_break_min := CASE WHEN v_break > 0
                      THEN CEIL(v_break::numeric / 15)::int * 15
                      ELSE 0 END;

  RETURN QUERY SELECT
    v_start,   -- 打刻そのまま
    v_end,     -- 打刻そのまま
    v_break,   -- 実際の休憩分数そのまま
    CASE
      WHEN v_start_min IS NULL OR v_end_min IS NULL OR v_end_min <= v_start_min THEN NULL
      ELSE GREATEST(0, v_end_min - v_start_min - v_break_min)
    END;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.clock_summary(integer, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

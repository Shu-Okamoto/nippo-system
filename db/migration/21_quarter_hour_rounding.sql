-- ============================================================
-- 勤怠の15分丸め
-- ------------------------------------------------------------
-- 運用ルール:
--   出勤時刻 … 切り上げ(09:01 → 09:15)
--   退勤時刻 … 切り捨て(17:14 → 17:00)
--   休憩時間 … 切り上げ(47分 → 60分)
--
-- 出退勤とも15分境界に丸めるので差は必ず15の倍数になり、休憩も
-- 15の倍数なので、実働は常に 0.25 時間刻みになる。
--
-- clock_summary() を差し替えるだけで、これを使っている
-- get_clock_board / get_attendance_summary / get_attendance_month
-- がまとめて丸め後の値を返すようになる。
--
-- 打刻イベント(time_clock_events)自体は実打刻のまま保持する。
-- 丸めは集計時にのみ適用し、原本は労務記録として残す。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 13_decouple_punch_from_shift.sql 実行済み
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
  v_start_raw time;
  v_end_raw   time;
  v_start_min int;
  v_end_min   int;
  v_break_raw int := 0;
  v_break_min int := 0;
BEGIN
  SELECT min((event_at AT TIME ZONE 'Asia/Tokyo')::time)
    INTO v_start_raw
  FROM nippo.time_clock_events
  WHERE staff_id = p_staff_id AND work_date = p_work_date
    AND event_type = 'clock_in' AND NOT is_voided;

  SELECT max((event_at AT TIME ZONE 'Asia/Tokyo')::time)
    INTO v_end_raw
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
    INTO v_break_raw
  FROM ev
  WHERE event_type = 'break_begin' AND next_type = 'break_end';

  -- 15分丸め。休憩0分は切り上げずそのまま
  v_break_min := CASE WHEN v_break_raw > 0
                      THEN CEIL(v_break_raw::numeric / 15)::int * 15
                      ELSE 0 END;

  IF v_start_raw IS NOT NULL THEN
    v_start_min := CEIL(
      (EXTRACT(HOUR FROM v_start_raw) * 60 + EXTRACT(MINUTE FROM v_start_raw))::numeric / 15
    )::int * 15;
  END IF;

  IF v_end_raw IS NOT NULL THEN
    v_end_min := FLOOR(
      (EXTRACT(HOUR FROM v_end_raw) * 60 + EXTRACT(MINUTE FROM v_end_raw))::numeric / 15
    )::int * 15;
  END IF;

  RETURN QUERY SELECT
    -- 表示も丸め後の時刻にする(給与計算の根拠に合わせる)
    CASE WHEN v_start_min IS NULL THEN NULL
         ELSE make_time(LEAST(v_start_min / 60, 23), v_start_min % 60, 0) END,
    CASE WHEN v_end_min IS NULL THEN NULL
         ELSE make_time(LEAST(v_end_min / 60, 23), v_end_min % 60, 0) END,
    v_break_min,
    CASE
      WHEN v_start_min IS NULL OR v_end_min IS NULL OR v_end_min <= v_start_min THEN NULL
      ELSE GREATEST(0, v_end_min - v_start_min - v_break_min)
    END;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.clock_summary(integer, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

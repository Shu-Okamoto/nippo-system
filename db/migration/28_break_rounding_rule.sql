-- ============================================================
-- 休憩の丸めルールを修正
-- ------------------------------------------------------------
-- 休憩は「次の15分区切りまで上げる」。
-- ちょうど区切りの値も、その次の区切りに上がる。
--
--   1〜14分  → 15分
--   15〜29分 → 30分
--   30〜44分 → 45分
--   45〜59分 → 60分
--   60〜74分 → 75分
--
-- 単純な切り上げ(CEIL)だと 45分がそのまま45分になってしまい、
-- 運用ルールと合わない。区切りちょうどでも次に上げる必要がある。
--
--   誤: CEIL(45/15)*15 = 45
--   正: (FLOOR(45/15)+1)*15 = 60
--
-- 休憩0分は0分のまま。休憩を取っていない日を15分にはしない。
--
-- 出勤(切り上げ)・退勤(切り捨て)は変更しない。
-- 区切りちょうどの時刻はそのまま採用する(09:00 は 09:00)。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 27_rounded_export.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 休憩の丸め。1か所にまとめて、計算がずれないようにする
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.round_break_minutes(p_min integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $func$
  SELECT CASE
    WHEN COALESCE(p_min, 0) <= 0 THEN 0
    ELSE (FLOOR(p_min::numeric / 15)::int + 1) * 15
  END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.round_break_minutes(integer)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (2) 日次集計の実働計算に反映
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.clock_summary(
  p_staff_id  integer,
  p_work_date date
) RETURNS TABLE (
  start_time    time,
  end_time      time,
  break_minutes integer,
  work_minutes  integer,
  breaks        jsonb
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
  v_breaks    jsonb := '[]'::jsonb;
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

  WITH ev AS (
    SELECT event_type, event_at, id,
           lead(event_type) OVER (ORDER BY event_at, id) AS next_type,
           lead(event_at)   OVER (ORDER BY event_at, id) AS next_at
    FROM nippo.time_clock_events
    WHERE staff_id = p_staff_id AND work_date = p_work_date
      AND event_type IN ('break_begin','break_end') AND NOT is_voided
  ),
  pairs AS (
    SELECT
      event_at AS bs,
      CASE WHEN next_type = 'break_end' THEN next_at ELSE NULL END AS be
    FROM ev
    WHERE event_type = 'break_begin'
  )
  SELECT
    COALESCE(SUM(
      CASE WHEN be IS NOT NULL
           THEN EXTRACT(EPOCH FROM (be - bs)) / 60
           ELSE 0 END
    )::int, 0),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'begin', to_char(bs AT TIME ZONE 'Asia/Tokyo', 'HH24:MI'),
        'end',   CASE WHEN be IS NULL THEN NULL
                      ELSE to_char(be AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') END
      ) ORDER BY bs
    ), '[]'::jsonb)
  INTO v_break, v_breaks
  FROM pairs;

  -- 実働の計算専用。表示用の値には反映しない
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

  v_break_min := nippo.round_break_minutes(v_break);

  RETURN QUERY SELECT
    v_start,
    v_end,
    v_break,
    CASE
      WHEN v_start_min IS NULL OR v_end_min IS NULL OR v_end_min <= v_start_min THEN NULL
      ELSE GREATEST(0, v_end_min - v_start_min - v_break_min)
    END,
    v_breaks;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.clock_summary(integer, date)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (3) 書き出し(freee 送信・CSV)にも反映
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_attendance_export(
  p_slug text,
  p_from date,
  p_to   date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_rows     jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  IF p_to < p_from THEN
    RAISE EXCEPTION '期間の指定が不正です';
  END IF;

  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION '期間は1年以内で指定してください';
  END IF;

  WITH d AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS work_date
  ),
  base AS (
    SELECT
      s.id                              AS staff_id,
      s.name                            AS staff_name,
      s.freee_employee_id               AS freee_employee_id,
      s.sort_order                      AS sort_order,
      d.work_date                       AS work_date,
      cs.start_time,
      cs.end_time,
      cs.break_minutes,
      cs.work_minutes,
      cs.breaks
    FROM nippo.staff s
    CROSS JOIN d
    JOIN LATERAL nippo.clock_summary(s.id, d.work_date) cs ON true
    WHERE s.store_id = v_store_id
      AND EXISTS (
        SELECT 1 FROM nippo.time_clock_events e
        WHERE e.staff_id = s.id AND e.work_date = d.work_date AND NOT e.is_voided
      )
  ),
  rounded AS (
    SELECT
      base.*,
      CASE WHEN start_time IS NULL THEN NULL ELSE
        CEIL((EXTRACT(HOUR FROM start_time) * 60
            + EXTRACT(MINUTE FROM start_time))::numeric / 15)::int * 15
      END AS start_min,
      CASE WHEN end_time IS NULL THEN NULL ELSE
        FLOOR((EXTRACT(HOUR FROM end_time) * 60
             + EXTRACT(MINUTE FROM end_time))::numeric / 15)::int * 15
      END AS end_min,
      nippo.round_break_minutes(break_minutes) AS break_min
    FROM base
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'staff_name',        staff_name,
      'freee_employee_id', freee_employee_id,
      'date',              work_date,
      'start_time',        to_char(start_time, 'HH24:MI'),
      'end_time',          to_char(end_time,   'HH24:MI'),
      'break_minutes',     break_minutes,
      'breaks',            breaks,
      'rounded_start_time',
        CASE WHEN start_min IS NULL THEN NULL
             ELSE to_char(make_time(LEAST(start_min / 60, 23), start_min % 60, 0), 'HH24:MI') END,
      'rounded_end_time',
        CASE WHEN end_min IS NULL THEN NULL
             ELSE to_char(make_time(LEAST(end_min / 60, 23), end_min % 60, 0), 'HH24:MI') END,
      'rounded_break_minutes', break_min,
      'work_minutes',      work_minutes
    ) ORDER BY sort_order, staff_id, work_date
  ), '[]'::jsonb)
  INTO v_rows
  FROM rounded;

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_export(text, date, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 勤怠のメンバー別 月間ビュー
-- ------------------------------------------------------------
-- ・get_attendance_month(slug, staff_id, from, to)
--     1人のメンバーの指定期間を日別に返す。
--     打刻が無い日も行として返す(打刻もれの発見と補完のため)。
--
-- 集計は clock_summary() を使い、shift_entries には依存しない。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 13_decouple_punch_from_shift.sql 実行済み
-- ============================================================

CREATE OR REPLACE FUNCTION nippo.get_attendance_month(
  p_slug     text,
  p_staff_id integer,
  p_from     date,
  p_to       date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id  int;
  v_name      text;
  v_days      jsonb;
  v_total_min int;
  v_work_days int;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  -- 退職者の勤怠も遡って見られるよう is_active は問わない
  SELECT name INTO v_name
  FROM nippo.staff
  WHERE id = p_staff_id AND store_id = v_store_id;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'この店舗に所属するスタッフではありません';
  END IF;

  IF p_to < p_from THEN
    RAISE EXCEPTION '期間の指定が不正です';
  END IF;

  WITH d AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS work_date
  ),
  s AS (
    SELECT
      d.work_date,
      cs.start_time,
      cs.end_time,
      cs.break_minutes,
      cs.work_minutes,
      (SELECT count(*)
       FROM nippo.time_clock_events e
       WHERE e.staff_id = p_staff_id
         AND e.work_date = d.work_date
         AND NOT e.is_voided) AS event_count
    FROM d
    JOIN LATERAL nippo.clock_summary(p_staff_id, d.work_date) cs ON true
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'date',          work_date,
        'start_time',    to_char(start_time, 'HH24:MI'),
        'end_time',      to_char(end_time,   'HH24:MI'),
        'break_minutes', break_minutes,
        'work_minutes',  work_minutes,
        'event_count',   event_count
      ) ORDER BY work_date
    ), '[]'::jsonb),
    COALESCE(SUM(work_minutes), 0)::int,
    COUNT(*) FILTER (WHERE event_count > 0)::int
  INTO v_days, v_total_min, v_work_days
  FROM s;

  RETURN jsonb_build_object(
    'staff_id',          p_staff_id,
    'staff_name',        v_name,
    'from',              p_from,
    'to',                p_to,
    'days',              v_days,
    'total_work_minutes', v_total_min,
    'work_days',         v_work_days
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_month(text, integer, date, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 勤怠データの書き出し(CSV用)
-- ------------------------------------------------------------
-- freee人事労務 の API 連携が使えない場合の代替手段として、
-- 期間内の勤怠を全メンバー分まとめて返す。
--
-- 打刻がある日だけを返す。値は clock_summary() と同じで、
-- 出退勤・休憩は打刻そのまま、実働だけ15分丸め。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 23_break_times.sql 実行済み
-- ============================================================

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

  -- 期間が長すぎると重いので上限を設ける
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION '期間は1年以内で指定してください';
  END IF;

  WITH d AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS work_date
  ),
  rows AS (
    SELECT
      s.id                              AS staff_id,
      s.name                            AS staff_name,
      s.freee_employee_id               AS freee_employee_id,
      s.sort_order                      AS sort_order,
      d.work_date                       AS work_date,
      cs.start_time,
      cs.end_time,
      cs.break_minutes,
      cs.work_minutes
    FROM nippo.staff s
    CROSS JOIN d
    JOIN LATERAL nippo.clock_summary(s.id, d.work_date) cs ON true
    WHERE s.store_id = v_store_id
      -- 打刻がある日だけ。空行を並べても取り込み側で邪魔になる
      AND EXISTS (
        SELECT 1 FROM nippo.time_clock_events e
        WHERE e.staff_id = s.id AND e.work_date = d.work_date AND NOT e.is_voided
      )
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'staff_name',        staff_name,
      'freee_employee_id', freee_employee_id,
      'date',              work_date,
      'start_time',        to_char(start_time, 'HH24:MI'),
      'end_time',          to_char(end_time,   'HH24:MI'),
      'break_minutes',     break_minutes,
      'work_minutes',      work_minutes
    ) ORDER BY sort_order, staff_id, work_date
  ), '[]'::jsonb)
  INTO v_rows
  FROM rows;

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_export(text, date, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

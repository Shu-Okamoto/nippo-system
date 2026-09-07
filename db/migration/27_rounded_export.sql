-- ============================================================
-- 勤務実績の送信用に丸め後の時刻を返す
-- ------------------------------------------------------------
-- 打刻(time_clocks)は「実際に押した時刻」をそのまま送るのが正しい。
-- 一方、勤務実績(work_records)は1日の労働時間そのものなので、
-- 月別ビューに出している実働と一致していないと給与計算が合わない。
--
-- そこで書き出しに丸め後の値を追加する。
--   rounded_start_time … 出勤を15分切り上げ
--   rounded_end_time   … 退勤を15分切り捨て
--   rounded_break_minutes … 休憩を15分切り上げ
--
--   work_minutes = rounded_end - rounded_start - rounded_break
--   となり、画面の実働と完全に一致する。
--
-- clock_summary() は画面表示で実打刻を出す必要があるため変更しない。
-- 丸めが要るのはこの書き出しだけなので、ここに閉じ込める。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 26_work_record_sync.sql 実行済み
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
      -- 出勤は切り上げ、退勤は切り捨て、休憩は切り上げ。
      -- clock_summary の work_minutes と同じ計算にする
      CASE WHEN start_time IS NULL THEN NULL ELSE
        CEIL((EXTRACT(HOUR FROM start_time) * 60
            + EXTRACT(MINUTE FROM start_time))::numeric / 15)::int * 15
      END AS start_min,
      CASE WHEN end_time IS NULL THEN NULL ELSE
        FLOOR((EXTRACT(HOUR FROM end_time) * 60
             + EXTRACT(MINUTE FROM end_time))::numeric / 15)::int * 15
      END AS end_min,
      CASE WHEN break_minutes > 0
           THEN CEIL(break_minutes::numeric / 15)::int * 15
           ELSE 0 END AS break_min
    FROM base
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'staff_name',        staff_name,
      'freee_employee_id', freee_employee_id,
      'date',              work_date,
      -- 実打刻(CSV や画面確認用)
      'start_time',        to_char(start_time, 'HH24:MI'),
      'end_time',          to_char(end_time,   'HH24:MI'),
      'break_minutes',     break_minutes,
      'breaks',            breaks,
      -- 丸め後(freee の勤務実績に送る値)
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


-- ------------------------------------------------------------
-- 自動送信用に、稼働中の店舗 slug を返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_active_store_slugs()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
  SELECT COALESCE(jsonb_agg(slug ORDER BY id), '[]'::jsonb)
  FROM nippo.stores WHERE is_active;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_active_store_slugs()
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 過去分を freee に送るための下準備
-- ------------------------------------------------------------
-- freee の打刻API(time_clocks)は当日の打刻を順に登録するもので、
-- 過去日をまとめて登録する用途には向かない。
-- 過去分は勤務実績API(work_records)に1日分の出退勤・休憩を
-- まとめて書く方式に切り替える。
--
-- ・get_attendance_export に breaks を追加(休憩の入り/戻りが必要)
-- ・retry_freee_errors : エラーになった打刻を再送対象に戻す
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 25_attendance_export.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 書き出しに休憩の入り/戻りを含める
--     work_records は break_records に開始・終了の時刻が要るため
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
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'staff_name',        staff_name,
      'freee_employee_id', freee_employee_id,
      'date',              work_date,
      'start_time',        to_char(start_time, 'HH24:MI'),
      'end_time',          to_char(end_time,   'HH24:MI'),
      'break_minutes',     break_minutes,
      'work_minutes',      work_minutes,
      'breaks',            breaks
    ) ORDER BY sort_order, staff_id, work_date
  ), '[]'::jsonb)
  INTO v_rows
  FROM rows;

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_export(text, date, date)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (2) エラーになった打刻を再送対象に戻す
--     原因を直したあと、まとめて pending に戻して送り直せるように
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.retry_freee_errors(
  p_slug text,
  p_from date,
  p_to   date
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_count    int;
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '再送には管理画面へのログインが必要です';
  END IF;

  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  -- 送信済み(sent)と手動対応中(manual)は触らない。
  -- 二重登録や、freee 側で直した内容の上書きを避けるため
  UPDATE nippo.time_clock_events
  SET freee_status = 'pending', freee_error = NULL
  WHERE store_id = v_store_id
    AND work_date BETWEEN p_from AND p_to
    AND NOT is_voided
    AND freee_status IN ('error', 'skipped');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.retry_freee_errors(text, date, date)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (3) 打刻を送信対象から外す
--     過去分を勤務実績API で送った場合、打刻側は送る必要がなくなる
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.skip_freee_punches(
  p_slug text,
  p_from date,
  p_to   date,
  p_note text DEFAULT '勤務実績APIで送信済み'
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_count    int;
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '操作には管理画面へのログインが必要です';
  END IF;

  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  UPDATE nippo.time_clock_events
  SET freee_status = 'skipped', freee_error = p_note,
      freee_synced_at = now()
  WHERE store_id = v_store_id
    AND work_date BETWEEN p_from AND p_to
    AND freee_status IN ('pending', 'error');

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.skip_freee_punches(text, date, date, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

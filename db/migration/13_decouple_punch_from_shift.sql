-- ============================================================
-- 勤怠打刻と日報の実績入力を切り離す
-- ------------------------------------------------------------
-- 方針変更:
--   ・日報の「実績入力」は店長が経営者目線で入力するものとして残す
--   ・勤怠打刻は労務記録として独立して持つ
--   ・打刻は日報(shift_entries)に反映しない
--
-- 11_time_clock.sql / 12_punch_admin.sql で入れた
-- rebuild_actual_shift() による連携を外す。
-- 11・12 は履歴として残してあるので、新規構築時は 11 → 12 → 13 の順に
-- 実行すれば最終的にこのファイルの定義が有効になる。
--
-- 打刻の集計(出勤・退勤・休憩・実働)は shift_entries を経由せず
-- イベントログから直接計算する clock_summary() を新設する。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 11_time_clock.sql, 12_punch_admin.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 打刻の日次集計をイベントログから直接計算する
--     shift_entries には一切依存しない
-- ------------------------------------------------------------
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
  v_break_min int := 0;
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
    INTO v_break_min
  FROM ev
  WHERE event_type = 'break_begin' AND next_type = 'break_end';

  RETURN QUERY SELECT
    v_start,
    v_end,
    v_break_min,
    CASE
      WHEN v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN NULL
      ELSE GREATEST(
        0,
        (EXTRACT(EPOCH FROM (v_end - v_start)) / 60)::int - v_break_min
      )
    END;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.clock_summary(integer, date)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (2) 打刻の日次一覧(管理画面のサマリー用)
--     打刻がある人だけを返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_attendance_summary(
  p_slug text,
  p_date date
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

  SELECT COALESCE(jsonb_agg(x ORDER BY x.sort_order, x.staff_id), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT
      s.id                                    AS staff_id,
      s.name                                  AS name,
      s.sort_order                            AS sort_order,
      to_char(cs.start_time, 'HH24:MI')       AS start_time,
      to_char(cs.end_time,   'HH24:MI')       AS end_time,
      cs.break_minutes                        AS break_minutes,
      cs.work_minutes                         AS work_minutes
    FROM nippo.staff s
    JOIN LATERAL nippo.clock_summary(s.id, p_date) cs ON true
    WHERE s.store_id = v_store_id
      AND EXISTS (
        SELECT 1 FROM nippo.time_clock_events e
        WHERE e.staff_id = s.id AND e.work_date = p_date AND NOT e.is_voided
      )
  ) x;

  RETURN jsonb_build_object('date', p_date, 'members', v_rows);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_summary(text, date)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (3) 打刻ボードを shift_entries 非依存に作り直す
--     休憩時間はイベントログから計算する
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_clock_board(
  p_slug text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_today    date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_members  jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  SELECT COALESCE(jsonb_agg(m ORDER BY m.sort_order, m.staff_id), '[]'::jsonb)
    INTO v_members
  FROM (
    SELECT
      s.id                                   AS staff_id,
      s.name                                 AS name,
      s.role                                 AS role,
      s.sort_order                           AS sort_order,
      v_today                                AS work_date,
      COALESCE(
        (SELECT e.event_type
         FROM nippo.time_clock_events e
         WHERE e.staff_id = s.id AND e.work_date = v_today AND NOT e.is_voided
         ORDER BY e.event_at DESC, e.id DESC
         LIMIT 1),
        'none'
      )                                      AS last_event,
      to_char(cs.start_time, 'HH24:MI')      AS clock_in_at,
      to_char(cs.end_time,   'HH24:MI')      AS clock_out_at,
      cs.break_minutes                       AS break_minutes
    FROM nippo.staff s
    JOIN LATERAL nippo.clock_summary(s.id, v_today) cs ON true
    WHERE s.store_id = v_store_id AND s.is_active
  ) m;

  RETURN jsonb_build_object(
    'store_name',  (SELECT name FROM nippo.stores WHERE id = v_store_id),
    'today',       v_today,
    'server_time', to_char(now() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI'),
    'members',     v_members
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_clock_board(text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 打刻系の関数から shift_entries への反映を外す
-- ------------------------------------------------------------

-- 4-1. punch: 日報も作らない(打刻だけで日報の器ができてしまうため)
CREATE OR REPLACE FUNCTION nippo.punch(
  p_slug       text,
  p_staff_id   integer,
  p_event_type text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id   int;
  v_now        timestamptz := now();
  v_work_date  date := (v_now AT TIME ZONE 'Asia/Tokyo')::date;
  v_last       text;
  v_event_id   bigint;
BEGIN
  IF p_event_type NOT IN ('clock_in','break_begin','break_end','clock_out') THEN
    RAISE EXCEPTION '不正な打刻種別です: %', p_event_type;
  END IF;

  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nippo.staff
    WHERE id = p_staff_id AND store_id = v_store_id AND is_active
  ) THEN
    RAISE EXCEPTION 'この店舗に所属する有効なスタッフではありません';
  END IF;

  SELECT event_type INTO v_last
  FROM nippo.time_clock_events
  WHERE staff_id = p_staff_id AND work_date = v_work_date AND NOT is_voided
  ORDER BY event_at DESC, id DESC
  LIMIT 1;

  IF p_event_type = 'clock_in' THEN
    IF v_last = 'clock_out' THEN
      RAISE EXCEPTION '本日は退勤済みです。修正が必要な場合は管理画面から取り消してください';
    ELSIF v_last IS NOT NULL THEN
      RAISE EXCEPTION '既に出勤済みです';
    END IF;
  ELSIF p_event_type = 'break_begin' THEN
    IF v_last IS NULL OR v_last = 'clock_out' THEN
      RAISE EXCEPTION '出勤打刻がありません';
    END IF;
    IF v_last = 'break_begin' THEN
      RAISE EXCEPTION '既に休憩中です';
    END IF;
  ELSIF p_event_type = 'break_end' THEN
    IF v_last IS DISTINCT FROM 'break_begin' THEN
      RAISE EXCEPTION '休憩を開始していません';
    END IF;
  ELSIF p_event_type = 'clock_out' THEN
    IF v_last IS NULL OR v_last = 'clock_out' THEN
      RAISE EXCEPTION '出勤打刻がありません';
    END IF;
    IF v_last = 'break_begin' THEN
      RAISE EXCEPTION '休憩中です。先に休憩戻りを押してください';
    END IF;
  END IF;

  INSERT INTO nippo.time_clock_events (
    store_id, staff_id, work_date, event_type, event_at
  ) VALUES (
    v_store_id, p_staff_id, v_work_date, p_event_type, v_now
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object(
    'event_id',   v_event_id,
    'staff_id',   p_staff_id,
    'work_date',  v_work_date,
    'event_type', p_event_type,
    'event_time', to_char(v_now AT TIME ZONE 'Asia/Tokyo', 'HH24:MI')
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.punch(text, integer, text)
  TO anon, authenticated, service_role;


-- 4-2. add_punch
CREATE OR REPLACE FUNCTION nippo.add_punch(
  p_slug       text,
  p_staff_id   integer,
  p_work_date  date,
  p_event_type text,
  p_time       text,
  p_note       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_event_id bigint;
BEGIN
  IF p_event_type NOT IN ('clock_in','break_begin','break_end','clock_out') THEN
    RAISE EXCEPTION '不正な打刻種別です: %', p_event_type;
  END IF;

  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM nippo.staff WHERE id = p_staff_id AND store_id = v_store_id
  ) THEN
    RAISE EXCEPTION 'この店舗に所属するスタッフではありません';
  END IF;

  INSERT INTO nippo.time_clock_events (
    store_id, staff_id, work_date, event_type, event_at, source, note, edited_at
  ) VALUES (
    v_store_id, p_staff_id, p_work_date, p_event_type,
    nippo.jst_timestamp(p_work_date, p_time), 'admin', p_note, now()
  )
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object('event_id', v_event_id);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.add_punch(text, integer, date, text, text, text)
  TO anon, authenticated, service_role;


-- 4-3. update_punch
CREATE OR REPLACE FUNCTION nippo.update_punch(
  p_event_id   bigint,
  p_event_type text,
  p_time       text,
  p_note       text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_work_date date;
  v_status    text;
BEGIN
  IF p_event_type NOT IN ('clock_in','break_begin','break_end','clock_out') THEN
    RAISE EXCEPTION '不正な打刻種別です: %', p_event_type;
  END IF;

  SELECT work_date, freee_status
    INTO v_work_date, v_status
  FROM nippo.time_clock_events
  WHERE id = p_event_id;

  IF v_work_date IS NULL THEN
    RAISE EXCEPTION '打刻が見つかりません';
  END IF;

  UPDATE nippo.time_clock_events
  SET event_type   = p_event_type,
      event_at     = nippo.jst_timestamp(v_work_date, p_time),
      note         = COALESCE(p_note, note),
      edited_at    = now(),
      freee_status = CASE WHEN v_status = 'sent' THEN 'manual' ELSE v_status END,
      freee_error  = CASE
                       WHEN v_status = 'sent'
                       THEN 'freee送信後に修正されました。freee側は手動で直してください'
                       ELSE freee_error
                     END
  WHERE id = p_event_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.update_punch(bigint, text, text, text)
  TO anon, authenticated, service_role;


-- 4-4. delete_punch
CREATE OR REPLACE FUNCTION nippo.delete_punch(
  p_event_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  UPDATE nippo.time_clock_events
  SET is_voided    = true,
      voided_at    = now(),
      freee_status = CASE
                       WHEN freee_status = 'pending' THEN 'skipped'
                       WHEN freee_status = 'sent'    THEN 'manual'
                       ELSE freee_status
                     END,
      freee_error  = CASE
                       WHEN freee_status = 'sent'
                       THEN 'freee送信後に削除されました。freee側は手動で消してください'
                       ELSE freee_error
                     END
  WHERE id = p_event_id AND NOT is_voided;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.delete_punch(bigint)
  TO anon, authenticated, service_role;


-- 4-5. restore_punch
CREATE OR REPLACE FUNCTION nippo.restore_punch(
  p_event_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  UPDATE nippo.time_clock_events
  SET is_voided    = false,
      voided_at    = NULL,
      edited_at    = now(),
      freee_status = CASE WHEN freee_status = 'skipped' THEN 'pending' ELSE freee_status END
  WHERE id = p_event_id AND is_voided;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.restore_punch(bigint)
  TO anon, authenticated, service_role;


-- 4-6. void_punch(11で作った旧名)も同様に無害化しておく
CREATE OR REPLACE FUNCTION nippo.void_punch(
  p_event_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  PERFORM nippo.delete_punch(p_event_id);
END;
$func$;


-- ------------------------------------------------------------
-- (5) 実績シフト再構築関数を廃止
--     これ以降、打刻は shift_entries に一切触れない
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS nippo.rebuild_actual_shift(integer, integer, date);


-- ============================================================
-- (6) 検証で作られた実績シフトの掃除(手動・任意)
-- ------------------------------------------------------------
-- 11 の検証中に打刻した分は shift_entries(actual)に書き込まれている。
-- 打刻と日報を分離した以上、その行は日報側の入力ではないので消したい。
--
-- ただし店長が手入力した実績と混ざっている可能性があるため、
-- 自動では消さない。下の SELECT で中身を確認してから、
-- 必要なら DELETE のコメントを外して実行すること。
-- ============================================================

-- 確認: 打刻がある日付・スタッフの実績シフト行を一覧する
--
-- SELECT dr.report_date, s.name, se.start_time, se.end_time,
--        se.break_minutes, se.id AS shift_id
-- FROM nippo.shift_entries se
-- JOIN nippo.daily_reports dr ON dr.id = se.daily_report_id
-- LEFT JOIN nippo.staff s ON s.id = se.staff_id
-- WHERE se.entry_type = 'actual'
--   AND EXISTS (
--     SELECT 1 FROM nippo.time_clock_events e
--     WHERE e.staff_id = se.staff_id AND e.work_date = dr.report_date
--   )
-- ORDER BY dr.report_date, s.sort_order;

-- 削除: 上で確認した行を消す場合のみコメントを外す
--
-- DELETE FROM nippo.shift_entries se
-- USING nippo.daily_reports dr
-- WHERE dr.id = se.daily_report_id
--   AND se.entry_type = 'actual'
--   AND EXISTS (
--     SELECT 1 FROM nippo.time_clock_events e
--     WHERE e.staff_id = se.staff_id AND e.work_date = dr.report_date
--   );

NOTIFY pgrst, 'reload schema';

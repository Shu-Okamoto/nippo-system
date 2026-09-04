-- ============================================================
-- 休憩の入り/戻り時刻を集計に含める
-- ------------------------------------------------------------
-- 勤怠管理の集計で、休憩の合計分数だけでなく実際の
-- 「休憩入」「休憩戻」の時刻も表示できるようにする。
--
-- 休憩は1日に複数回あり得るので配列で返す。
--   [{"begin":"12:00","end":"12:47"}, {"begin":"15:00","end":"15:10"}]
--
-- 休憩に入ったまま戻っていない場合は end を null にして返す
-- (休憩中であることが画面で分かるように)。
--
-- 時刻は打刻そのまま。丸めは実働の計算時のみ。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 22_round_work_minutes_only.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) clock_summary に breaks を追加
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS nippo.clock_summary(integer, date);

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

  -- break_begin と直後の break_end をペアにする。
  -- 戻り忘れ(次が break_end でない)は end = null のまま残す
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

  v_break_min := CASE WHEN v_break > 0
                      THEN CEIL(v_break::numeric / 15)::int * 15
                      ELSE 0 END;

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
-- (2) 日次サマリーに breaks を含める
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
      cs.work_minutes                         AS work_minutes,
      cs.breaks                               AS breaks
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
-- (3) 月次にも breaks を含める
-- ------------------------------------------------------------
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
      cs.breaks,
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
        'breaks',        breaks,
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


-- ------------------------------------------------------------
-- (4) 打刻ボードは列が増えた clock_summary に合わせて作り直す
--     (RETURNS TABLE の形が変わったため参照側も再作成が必要)
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
  v_require  boolean;
  v_members  jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  SELECT COALESCE(require_punch_pin, true) INTO v_require
  FROM nippo.app_settings WHERE id = 1;
  v_require := COALESCE(v_require, true);

  SELECT COALESCE(jsonb_agg(m ORDER BY m.sort_order, m.staff_id), '[]'::jsonb)
    INTO v_members
  FROM (
    SELECT
      s.id                                   AS staff_id,
      s.name                                 AS name,
      s.role                                 AS role,
      s.sort_order                           AS sort_order,
      v_today                                AS work_date,
      (sp.pin_hash IS NOT NULL)              AS has_pin,
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
    LEFT JOIN nippo.staff_private sp ON sp.staff_id = s.id
    JOIN LATERAL nippo.clock_summary(s.id, v_today) cs ON true
    WHERE s.store_id = v_store_id AND s.is_active
  ) m;

  RETURN jsonb_build_object(
    'store_name',  (SELECT name FROM nippo.stores WHERE id = v_store_id),
    'today',       v_today,
    'server_time', to_char(now() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI'),
    'require_pin', v_require,
    'members',     v_members
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_clock_board(text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 個人打刻画面も同様に作り直す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_personal_clock(
  p_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_staff_id int;
  v_name     text;
  v_store_id int;
  v_store    text;
  v_slug     text;
  v_active   boolean;
  v_has_pin  boolean;
  v_require  boolean;
  v_today    date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_last     text;
  v_cs       record;
BEGIN
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'この打刻URLは無効です';
  END IF;

  SELECT s.id, s.name, s.store_id, s.is_active, (sp.pin_hash IS NOT NULL)
    INTO v_staff_id, v_name, v_store_id, v_active, v_has_pin
  FROM nippo.staff_private sp
  JOIN nippo.staff s ON s.id = sp.staff_id
  WHERE sp.clock_token = p_token;

  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'この打刻URLは無効です。本部に連絡してください';
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'このアカウントは停止中です。本部に連絡してください';
  END IF;

  SELECT name, slug INTO v_store, v_slug
  FROM nippo.stores WHERE id = v_store_id AND is_active;

  IF v_slug IS NULL THEN
    RAISE EXCEPTION '店舗が停止中です。本部に連絡してください';
  END IF;

  SELECT COALESCE(require_punch_pin, true) INTO v_require
  FROM nippo.app_settings WHERE id = 1;
  v_require := COALESCE(v_require, true);

  SELECT COALESCE(
    (SELECT e.event_type
     FROM nippo.time_clock_events e
     WHERE e.staff_id = v_staff_id AND e.work_date = v_today AND NOT e.is_voided
     ORDER BY e.event_at DESC, e.id DESC
     LIMIT 1),
    'none'
  ) INTO v_last;

  SELECT * INTO v_cs FROM nippo.clock_summary(v_staff_id, v_today);

  RETURN jsonb_build_object(
    'staff_id',    v_staff_id,
    'name',        v_name,
    'store_name',  v_store,
    'today',       v_today,
    'server_time', to_char(now() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI'),
    'require_pin', v_require,
    'has_pin',     v_has_pin,
    'last_event',  v_last,
    'clock_in_at',  to_char(v_cs.start_time, 'HH24:MI'),
    'clock_out_at', to_char(v_cs.end_time,   'HH24:MI'),
    'break_minutes', v_cs.break_minutes
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_personal_clock(text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

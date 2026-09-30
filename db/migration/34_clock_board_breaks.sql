-- ============================================================
-- 打刻画面に当日の休憩時刻を返す
-- ------------------------------------------------------------
-- 打刻画面では休憩は「休60分」と分数でしか出ていなかった。
-- 本人が「何時に休憩に入ったか」を確認できないため、
-- 休憩戻りを押すときに入り時刻が分からない。
--
-- clock_summary() は既に breaks(入り/戻りの配列)を返しているので、
-- 打刻ボードと個人打刻画面でもそれをそのまま渡すだけでよい。
--
--   breaks = [{ "begin": "12:00", "end": "13:05" }, ...]
--   戻り未打刻(休憩中)は end が null になる
--
-- 時刻は打刻そのまま。丸めは実働の計算だけに使う方針を維持する。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 23_break_times.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 店舗の打刻ボード。メンバーごとに breaks を追加
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
      cs.break_minutes                       AS break_minutes,
      -- 本人が休憩の入り時刻を確認できるようにする
      COALESCE(cs.breaks, '[]'::jsonb)       AS breaks
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
-- (2) 個人専用打刻画面も同様に breaks を返す
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
    'break_minutes', v_cs.break_minutes,
    -- 本人が休憩の入り時刻を確認できるようにする
    'breaks',        COALESCE(v_cs.breaks, '[]'::jsonb)
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_personal_clock(text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 個人専用の打刻URL(LINE配信用)
-- ------------------------------------------------------------
-- DX 側の LINE メッセージング(フックポイントでユーザーを識別)から
-- 個人ごとに違う URL を配り、開いた本人の打刻画面だけを表示する。
--
--   https://<host>/clock/<token>
--
-- token はメンバーごとの長いランダム文字列。staff_private に置くので
-- 公開テーブル(staff)からは漏れない。管理画面から再発行できる。
--
-- 【セキュリティ】
--   URL は LINE のトーク履歴に残り、転送・スクリーンショットもできる。
--   URL だけで打刻できると「本人でない人が打刻できる」状態になるため、
--   PIN 設定が「必要」のときは個人URLでも PIN を求める。
--   URL は「誰の画面か」を決めるだけで、本人確認は PIN が担う。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 17_punch_pin_toggle.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) メンバーごとの打刻トークン
-- ------------------------------------------------------------
ALTER TABLE nippo.staff_private
  ADD COLUMN IF NOT EXISTS clock_token text;

ALTER TABLE nippo.staff_private
  ADD COLUMN IF NOT EXISTS clock_token_issued_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS staff_private_clock_token_idx
  ON nippo.staff_private (clock_token)
  WHERE clock_token IS NOT NULL;


-- ------------------------------------------------------------
-- (2) トークンの発行・再発行(管理画面のみ)
--     既に発行済みなら作り直さず既存を返す。
--     p_force = true で再発行(古いURLは即座に無効になる)。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.issue_clock_token(
  p_staff_id integer,
  p_force    boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public, extensions
AS $func$
DECLARE
  v_token text;
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '打刻URLの発行には管理画面へのログインが必要です';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM nippo.staff WHERE id = p_staff_id) THEN
    RAISE EXCEPTION 'スタッフが見つかりません';
  END IF;

  SELECT clock_token INTO v_token
  FROM nippo.staff_private WHERE staff_id = p_staff_id;

  IF v_token IS NOT NULL AND NOT p_force THEN
    RETURN v_token;
  END IF;

  -- 48文字の16進。総当たりは現実的でない長さにする
  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  INSERT INTO nippo.staff_private (staff_id, clock_token, clock_token_issued_at)
  VALUES (p_staff_id, v_token, now())
  ON CONFLICT (staff_id) DO UPDATE SET
    clock_token = EXCLUDED.clock_token,
    clock_token_issued_at = now();

  RETURN v_token;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.issue_clock_token(integer, boolean)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (3) トークンの失効(管理画面のみ)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.revoke_clock_token(
  p_staff_id integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '打刻URLの失効には管理画面へのログインが必要です';
  END IF;

  UPDATE nippo.staff_private
  SET clock_token = NULL, clock_token_issued_at = NULL
  WHERE staff_id = p_staff_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.revoke_clock_token(integer)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 管理画面向け一覧にトークンを含める
--     DX 側に配る URL を作れるよう、ここでは実トークンを返す。
--     is_admin() でログイン済みに限定している。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_staff_private()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '管理画面へのログインが必要です';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'staff_id',    s.id,
      'has_pin',     (sp.pin_hash IS NOT NULL),
      'pin_set_at',  sp.pin_set_at,
      'locked',      (sp.pin_locked_until IS NOT NULL AND sp.pin_locked_until > now()),
      'hourly_wage', sp.hourly_wage,
      'clock_token', sp.clock_token
    ) ORDER BY s.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM nippo.staff s
  LEFT JOIN nippo.staff_private sp ON sp.staff_id = s.id;

  RETURN v_rows;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_staff_private()
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 個人打刻画面の初期表示
--     トークンからメンバーを引き、その人の当日状態だけを返す。
--     他のメンバーの情報は一切返さない。
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


-- ------------------------------------------------------------
-- (6) トークン経由の打刻
--     staff_id を受け取らないので、他人になりすまして打刻できない。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.punch_by_token(
  p_token      text,
  p_event_type text,
  p_pin        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public, extensions
AS $func$
DECLARE
  v_staff_id int;
  v_slug     text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'この打刻URLは無効です';
  END IF;

  SELECT s.id, st.slug
    INTO v_staff_id, v_slug
  FROM nippo.staff_private sp
  JOIN nippo.staff  s  ON s.id  = sp.staff_id
  JOIN nippo.stores st ON st.id = s.store_id AND st.is_active
  WHERE sp.clock_token = p_token AND s.is_active;

  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'この打刻URLは無効です。本部に連絡してください';
  END IF;

  -- PIN の要否判定と打刻の順序検証は punch_with_pin() 側に任せる
  RETURN nippo.punch_with_pin(v_slug, v_staff_id, p_event_type, p_pin);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.punch_by_token(text, text, text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

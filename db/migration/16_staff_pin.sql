-- ============================================================
-- メンバー別 PIN 認証 + 時給などの非公開情報
-- ------------------------------------------------------------
-- ・打刻はメンバー本人の PIN が無いとできないようにする
-- ・PIN と時給はスタッフマスタの一部として管理画面から設定する
--
-- 【重要】PIN ハッシュと時給を nippo.staff に直接持たせない理由:
--   アプリは staff を `select('*')` で読んでおり、Phase 1 は anon
--   アクセス前提なので、staff に置くと PIN ハッシュと時給が
--   ブラウザに配られてしまう。4〜6桁の PIN はハッシュが漏れると
--   オフラインで総当たりされるため、別テーブルに隔離して
--   SECURITY DEFINER の RPC 経由でしか触れないようにする。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 15_punch_list_rpc.sql まで実行済み
-- ============================================================

-- bcrypt を使うため(Supabase では通常 extensions スキーマに導入済み)
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- ------------------------------------------------------------
-- (1) スタッフの非公開情報
--     anon / authenticated からは直接読めない。RPC 経由のみ。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.staff_private (
  staff_id          integer     PRIMARY KEY
                                REFERENCES nippo.staff(id) ON DELETE CASCADE,
  pin_hash          text,
  pin_set_at        timestamptz,
  pin_failed_count  integer     NOT NULL DEFAULT 0,
  pin_locked_until  timestamptz,
  hourly_wage       integer,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_staff_private_updated ON nippo.staff_private;
CREATE TRIGGER trg_staff_private_updated
  BEFORE UPDATE ON nippo.staff_private
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

-- 直接アクセスを塞ぐ。service_role は RLS をバイパスする
ALTER TABLE nippo.staff_private ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nippo.staff_private FROM anon, authenticated;


-- ------------------------------------------------------------
-- (2) 呼び出し元がログイン済みか(管理画面か)を判定する
--     打刻端末は未認証(anon)なので、PIN 発行や時給の閲覧は
--     ログイン済みのときだけ許可する
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $func$
DECLARE
  v_role text;
BEGIN
  v_role := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  RETURN v_role = 'authenticated';
EXCEPTION WHEN others THEN
  -- JWT が無い/壊れている場合は管理者ではない扱い
  RETURN false;
END;
$func$;


-- ------------------------------------------------------------
-- (3) PIN の設定・解除(管理画面から)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_staff_pin(
  p_staff_id integer,
  p_pin      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public, extensions
AS $func$
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION 'PINの設定には管理画面へのログインが必要です';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM nippo.staff WHERE id = p_staff_id) THEN
    RAISE EXCEPTION 'スタッフが見つかりません';
  END IF;

  -- NULL/空文字は PIN 解除(打刻できなくなる)
  IF p_pin IS NULL OR btrim(p_pin) = '' THEN
    INSERT INTO nippo.staff_private (staff_id, pin_hash, pin_set_at,
                                     pin_failed_count, pin_locked_until)
    VALUES (p_staff_id, NULL, NULL, 0, NULL)
    ON CONFLICT (staff_id) DO UPDATE SET
      pin_hash = NULL, pin_set_at = NULL,
      pin_failed_count = 0, pin_locked_until = NULL;
    RETURN;
  END IF;

  IF p_pin !~ '^[0-9]{4,6}$' THEN
    RAISE EXCEPTION 'PINは4〜6桁の数字で設定してください';
  END IF;

  INSERT INTO nippo.staff_private (staff_id, pin_hash, pin_set_at,
                                   pin_failed_count, pin_locked_until)
  VALUES (p_staff_id, extensions.crypt(p_pin, extensions.gen_salt('bf')), now(), 0, NULL)
  ON CONFLICT (staff_id) DO UPDATE SET
    pin_hash         = EXCLUDED.pin_hash,
    pin_set_at       = now(),
    pin_failed_count = 0,
    pin_locked_until = NULL;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_staff_pin(integer, text)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 時給の設定(管理画面から)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_staff_wage(
  p_staff_id    integer,
  p_hourly_wage integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '時給の設定には管理画面へのログインが必要です';
  END IF;

  IF p_hourly_wage IS NOT NULL AND p_hourly_wage < 0 THEN
    RAISE EXCEPTION '時給は0以上で入力してください';
  END IF;

  INSERT INTO nippo.staff_private (staff_id, hourly_wage)
  VALUES (p_staff_id, p_hourly_wage)
  ON CONFLICT (staff_id) DO UPDATE SET hourly_wage = EXCLUDED.hourly_wage;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_staff_wage(integer, integer)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 管理画面向けの一覧
--     PIN ハッシュは絶対に返さない。設定済みかどうかだけ返す。
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
      'hourly_wage', sp.hourly_wage
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
-- (6) PIN 認証つきの打刻
--     打刻端末は未認証なので anon から呼べる必要がある。
--     PIN ハッシュは返さず、失敗回数で総当たりを抑止する。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.punch_with_pin(
  p_slug       text,
  p_staff_id   integer,
  p_event_type text,
  p_pin        text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public, extensions
AS $func$
DECLARE
  v_hash    text;
  v_locked  timestamptz;
  v_failed  int;
  v_wait    int;
BEGIN
  SELECT sp.pin_hash, sp.pin_locked_until, sp.pin_failed_count
    INTO v_hash, v_locked, v_failed
  FROM nippo.staff_private sp
  WHERE sp.staff_id = p_staff_id;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'PINが未設定です。本部に連絡してください';
  END IF;

  IF v_locked IS NOT NULL AND v_locked > now() THEN
    v_wait := CEIL(EXTRACT(EPOCH FROM (v_locked - now())) / 60);
    RAISE EXCEPTION 'PINを続けて間違えたためロック中です。あと約%分お待ちください', v_wait;
  END IF;

  IF v_hash <> extensions.crypt(COALESCE(p_pin, ''), v_hash) THEN
    -- 5回連続で失敗したら10分ロック
    UPDATE nippo.staff_private
    SET pin_failed_count = pin_failed_count + 1,
        pin_locked_until = CASE
                             WHEN pin_failed_count + 1 >= 5 THEN now() + interval '10 minutes'
                             ELSE pin_locked_until
                           END
    WHERE staff_id = p_staff_id;

    RAISE EXCEPTION 'PINが違います';
  END IF;

  -- 成功したら失敗回数をリセット
  UPDATE nippo.staff_private
  SET pin_failed_count = 0, pin_locked_until = NULL
  WHERE staff_id = p_staff_id;

  -- 店舗・スタッフの妥当性と打刻の順序は punch() 側で検証する
  RETURN nippo.punch(p_slug, p_staff_id, p_event_type);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.punch_with_pin(text, integer, text, text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (7) 打刻ボードに「PIN設定済みか」を含める
--     未設定の人は打刻画面で押せないようにするため
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
    'members',     v_members
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_clock_board(text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (8) PIN 無しの打刻を塞ぐ
--     旧 punch() は punch_with_pin() から内部呼び出しするだけにし、
--     外部(PostgREST)からは呼べないようにする
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION nippo.punch(text, integer, text) FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

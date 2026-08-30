-- ============================================================
-- 打刻のPIN入力を全体設定で ON/OFF できるようにする
-- ------------------------------------------------------------
-- 運用によっては PIN 入力が煩わしい場面があるため、
-- 管理画面から「全員PINあり / 全員PINなし」を切り替えられるようにする。
-- メンバー個別ではなく全体一律の設定。
--
-- PIN なしにすると、名前を選ぶだけで打刻できる(16 以前の挙動)。
-- PIN 自体の設定は残るので、いつでも PIN ありに戻せる。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 16_staff_pin.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) アプリ全体の設定(1行のみ)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.app_settings (
  id                integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  require_punch_pin boolean     NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO nippo.app_settings (id, require_punch_pin)
VALUES (1, true)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_app_settings_updated ON nippo.app_settings;
CREATE TRIGGER trg_app_settings_updated
  BEFORE UPDATE ON nippo.app_settings
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

ALTER TABLE nippo.app_settings DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON nippo.app_settings TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (2) 設定の取得(誰でも)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_app_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_require boolean;
BEGIN
  SELECT require_punch_pin INTO v_require
  FROM nippo.app_settings WHERE id = 1;

  RETURN jsonb_build_object(
    'require_punch_pin', COALESCE(v_require, true)
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_app_settings()
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (3) 設定の変更(管理画面のみ)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_require_punch_pin(
  p_require boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '設定の変更には管理画面へのログインが必要です';
  END IF;

  INSERT INTO nippo.app_settings (id, require_punch_pin)
  VALUES (1, p_require)
  ON CONFLICT (id) DO UPDATE SET require_punch_pin = EXCLUDED.require_punch_pin;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_require_punch_pin(boolean)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 打刻: 設定が OFF なら PIN 検証をとばす
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.punch_with_pin(
  p_slug       text,
  p_staff_id   integer,
  p_event_type text,
  p_pin        text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public, extensions
AS $func$
DECLARE
  v_require boolean;
  v_hash    text;
  v_locked  timestamptz;
  v_wait    int;
BEGIN
  SELECT require_punch_pin INTO v_require
  FROM nippo.app_settings WHERE id = 1;
  v_require := COALESCE(v_require, true);

  IF v_require THEN
    SELECT sp.pin_hash, sp.pin_locked_until
      INTO v_hash, v_locked
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

    UPDATE nippo.staff_private
    SET pin_failed_count = 0, pin_locked_until = NULL
    WHERE staff_id = p_staff_id;
  END IF;

  -- 店舗・スタッフの妥当性と打刻の順序は punch() 側で検証する
  RETURN nippo.punch(p_slug, p_staff_id, p_event_type);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.punch_with_pin(text, integer, text, text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 打刻ボードに現在の設定を含める
--     画面側が PIN 入力を出すかどうかを判断できるようにする
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

NOTIFY pgrst, 'reload schema';

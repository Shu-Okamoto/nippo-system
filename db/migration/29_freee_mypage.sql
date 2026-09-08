-- ============================================================
-- freee 従業員マイページの案内をLINEで配るための情報
-- ------------------------------------------------------------
-- LINE で [給料] と送られたときに、freee のマイページURLと
-- その人のログインID(メールアドレス)を返す。
--
-- 【パスワードは持たない・配らない】
--   freee は招待メールから本人がパスワードを設定する方式。
--   仮に管理者が初期パスワードを知っていても、LINE で配ると
--   トーク履歴に残り、転送・スクリーンショット・端末紛失で
--   給与情報が漏れる。ID までに留める。
--
-- ログインIDは staff ではなく staff_private に置く。
-- staff はアプリが select('*') で読んでおり anon から見えるため。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 27_rounded_export.sql まで実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 従業員のログインID(メールアドレス)
-- ------------------------------------------------------------
ALTER TABLE nippo.staff_private
  ADD COLUMN IF NOT EXISTS freee_login_email text;


-- ------------------------------------------------------------
-- (2) マイページURLは全員共通なので設定として持つ
-- ------------------------------------------------------------
ALTER TABLE nippo.app_settings
  ADD COLUMN IF NOT EXISTS freee_mypage_url text;


-- ------------------------------------------------------------
-- (3) ログインIDの設定(管理画面のみ)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_staff_login_email(
  p_staff_id integer,
  p_email    text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_email text := NULLIF(btrim(COALESCE(p_email, '')), '');
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '設定には管理画面へのログインが必要です';
  END IF;

  IF v_email IS NOT NULL AND v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'メールアドレスの形式が正しくありません';
  END IF;

  INSERT INTO nippo.staff_private (staff_id, freee_login_email)
  VALUES (p_staff_id, v_email)
  ON CONFLICT (staff_id) DO UPDATE SET freee_login_email = EXCLUDED.freee_login_email;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_staff_login_email(integer, text)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (4) マイページURLの設定(管理画面のみ)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_freee_mypage_url(
  p_url text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '設定には管理画面へのログインが必要です';
  END IF;

  INSERT INTO nippo.app_settings (id, freee_mypage_url)
  VALUES (1, NULLIF(btrim(COALESCE(p_url, '')), ''))
  ON CONFLICT (id) DO UPDATE SET freee_mypage_url = EXCLUDED.freee_mypage_url;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_freee_mypage_url(text)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 管理画面向け一覧にログインIDを含める
--     PIN ハッシュは引き続き返さない
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
      'staff_id',          s.id,
      'has_pin',           (sp.pin_hash IS NOT NULL),
      'pin_set_at',        sp.pin_set_at,
      'locked',            (sp.pin_locked_until IS NOT NULL AND sp.pin_locked_until > now()),
      'hourly_wage',       sp.hourly_wage,
      'clock_token',       sp.clock_token,
      'freee_login_email', sp.freee_login_email
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
-- (6) 設定の取得にマイページURLを含める
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
  v_url     text;
BEGIN
  SELECT require_punch_pin, freee_mypage_url
    INTO v_require, v_url
  FROM nippo.app_settings WHERE id = 1;

  RETURN jsonb_build_object(
    'require_punch_pin', COALESCE(v_require, true),
    'freee_mypage_url',  v_url
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_app_settings()
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- freee ログインIDをメールアドレス以外にも対応させる
-- ------------------------------------------------------------
-- 実際に配布されているログインIDは
--   satonoajimikawa-00000010
-- のような形式で、メールアドレスではなかった。
--
-- 29_freee_mypage.sql ではメール形式で検証していたため入力できない。
-- 検証を緩め、列名も実態に合わせて freee_login_id に改める。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 29_freee_mypage.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 列名を実態に合わせる
--     29 を実行済みなら rename、未実行なら新規追加。どちらでも通る
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'nippo' AND table_name = 'staff_private'
      AND column_name = 'freee_login_email'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'nippo' AND table_name = 'staff_private'
      AND column_name = 'freee_login_id'
  ) THEN
    ALTER TABLE nippo.staff_private RENAME COLUMN freee_login_email TO freee_login_id;
  END IF;
END $$;

ALTER TABLE nippo.staff_private
  ADD COLUMN IF NOT EXISTS freee_login_id text;


-- ------------------------------------------------------------
-- (2) ログインIDの設定。形式は問わない
--     メールアドレスでも satonoajimikawa-00000010 のような形でもよい。
--     空白混入だけ弾く
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS nippo.set_staff_login_email(integer, text);

CREATE OR REPLACE FUNCTION nippo.set_staff_login_id(
  p_staff_id integer,
  p_login_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_id text := NULLIF(btrim(COALESCE(p_login_id, '')), '');
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '設定には管理画面へのログインが必要です';
  END IF;

  IF v_id IS NOT NULL AND v_id ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'ログインIDに空白は使えません';
  END IF;

  IF v_id IS NOT NULL AND length(v_id) > 200 THEN
    RAISE EXCEPTION 'ログインIDが長すぎます';
  END IF;

  INSERT INTO nippo.staff_private (staff_id, freee_login_id)
  VALUES (p_staff_id, v_id)
  ON CONFLICT (staff_id) DO UPDATE SET freee_login_id = EXCLUDED.freee_login_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_staff_login_id(integer, text)
  TO authenticated, service_role;


-- ------------------------------------------------------------
-- (3) 一覧の項目名も合わせる
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
      'staff_id',       s.id,
      'has_pin',        (sp.pin_hash IS NOT NULL),
      'pin_set_at',     sp.pin_set_at,
      'locked',         (sp.pin_locked_until IS NOT NULL AND sp.pin_locked_until > now()),
      'hourly_wage',    sp.hourly_wage,
      'clock_token',    sp.clock_token,
      'freee_login_id', sp.freee_login_id
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

NOTIFY pgrst, 'reload schema';

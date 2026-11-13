-- ============================================================
-- freee 連携の堅牢化
--   (1) トークン更新の直列化(使い捨てトークンの取りこぼし防止)
--   (2) 連携状態の記録(切れたら画面で気付けるようにする)
-- ------------------------------------------------------------
-- (1) の背景
--   freee のリフレッシュトークンは使い捨てで、更新のたびに新しいものが
--   発行され古いものは無効になる。18時の自動送信と手動送信が重なると
--   更新が同時に走り、後から保存したほうが勝って、もう一方が取得した
--   有効なトークンが捨てられる。結果 DB に無効なトークンだけが残り、
--   以後どう更新しても通らなくなる。
--
--   pg_advisory_lock は PostgREST の接続プールをまたいで保持できない
--   ため使えない。代わりに freee_tokens 行に期限付きのリースを持たせ、
--   単一の UPDATE 文で奪い合う。1文なので必ず1人だけが勝つ。
--
-- (2) の背景
--   2026-11-09 に連携が切れ、気付いたのが 11-13 だった。
--   送信結果をどこにも残していなかったため、画面を見ても分からない。
--   最後の結果を1行だけ持ち、失敗していれば勤怠管理に警告を出す。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 11_time_clock.sql / 16_staff_pin.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1-1) 更新リースの列
-- ------------------------------------------------------------
ALTER TABLE nippo.freee_tokens
  ADD COLUMN IF NOT EXISTS refresh_lock_until timestamptz;


-- ------------------------------------------------------------
-- (1-2) リースの取得。取れたら true
--       空いている(NULL or 期限切れ)ときだけ書けるので、
--       同時に呼ばれても1人しか true にならない
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.freee_refresh_lock(p_seconds integer DEFAULT 30)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_got boolean := false;
  v_sec integer := LEAST(GREATEST(COALESCE(p_seconds, 30), 5), 120);
BEGIN
  UPDATE nippo.freee_tokens
     SET refresh_lock_until = now() + make_interval(secs => v_sec)
   WHERE id = 1
     AND (refresh_lock_until IS NULL OR refresh_lock_until < now())
  RETURNING true INTO v_got;

  RETURN COALESCE(v_got, false);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.freee_refresh_lock(integer) TO service_role;


-- ------------------------------------------------------------
-- (1-3) リースの解放。更新が終わったら必ず呼ぶ。
--       呼び忘れても期限で自然に空く
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.freee_refresh_unlock()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
  UPDATE nippo.freee_tokens SET refresh_lock_until = NULL WHERE id = 1;
$func$;

GRANT EXECUTE ON FUNCTION nippo.freee_refresh_unlock() TO service_role;


-- ------------------------------------------------------------
-- (2-1) 連携状態。1行だけ持つ
--       エラー文には送信先やfreeeの応答が入るのでRLSで遮断し、
--       参照は管理者チェック付きのRPC経由にする
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.freee_health (
  id         integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok         boolean     NOT NULL,
  code       text,
  message    text,
  -- どの処理で記録したか(cron / sync / work_records / diag)
  context    text
);

ALTER TABLE nippo.freee_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nippo.freee_health FROM anon, authenticated;


-- ------------------------------------------------------------
-- (2-2) 記録。サーバ側(service_role)からのみ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_freee_health(
  p_ok      boolean,
  p_code    text DEFAULT NULL,
  p_message text DEFAULT NULL,
  p_context text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
BEGIN
  INSERT INTO nippo.freee_health (id, checked_at, ok, code, message, context)
  VALUES (1, now(), COALESCE(p_ok, false), p_code, left(COALESCE(p_message, ''), 2000), p_context)
  ON CONFLICT (id) DO UPDATE SET
    checked_at = now(),
    ok         = EXCLUDED.ok,
    code       = EXCLUDED.code,
    message    = EXCLUDED.message,
    context    = EXCLUDED.context;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_freee_health(boolean, text, text, text)
  TO service_role;


-- ------------------------------------------------------------
-- (2-3) 参照。管理画面から読む
--       未記録(まだ一度も送信していない)なら null を返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_freee_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_row nippo.freee_health;
BEGIN
  IF NOT nippo.is_admin() THEN
    RAISE EXCEPTION '管理画面へのログインが必要です';
  END IF;

  SELECT * INTO v_row FROM nippo.freee_health WHERE id = 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'checked_at', v_row.checked_at,
    'ok',         v_row.ok,
    'code',       v_row.code,
    'message',    v_row.message,
    'context',    v_row.context,
    -- 何時間前の記録か。古い記録で警告を出し続けないための判断材料
    'age_hours',  ROUND(EXTRACT(EPOCH FROM (now() - v_row.checked_at)) / 3600, 1)
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_freee_health()
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

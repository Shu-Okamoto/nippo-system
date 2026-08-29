-- ============================================================
-- 打刻の管理機能(追加・編集・削除・復元)
-- ------------------------------------------------------------
-- 打刻もれ・打ち間違いを本部側で修正できるようにする。
--
-- ・add_punch()     : 打刻もれを後から追加
-- ・update_punch()  : 時刻/種別を修正
-- ・delete_punch()  : 削除(取消フラグ。労務記録なので物理削除しない)
-- ・restore_punch() : 削除の取り消し
--
-- いずれも実行後に実績シフトを組み立て直す。
--
-- freee 送信済みの打刻を後から直しても freee 側は自動で変わらない。
-- そのため freee_status を 'manual'(要手動修正)にして管理画面で
-- 気付けるようにする。'manual' は再送対象にならない。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 11_time_clock.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) freee_status に 'manual'(要手動修正)を追加
-- ------------------------------------------------------------
ALTER TABLE nippo.time_clock_events
  DROP CONSTRAINT IF EXISTS time_clock_events_freee_status_check;

ALTER TABLE nippo.time_clock_events
  ADD CONSTRAINT time_clock_events_freee_status_check
  CHECK (freee_status IN ('pending','sent','skipped','error','manual'));

-- 手修正の記録(誰がいつ直したかまでは持たないが、修正済みは判別できる)
ALTER TABLE nippo.time_clock_events
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;


-- ------------------------------------------------------------
-- (2) JST の日付 + "HH:MM" から timestamptz を組み立てる
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.jst_timestamp(
  p_date date,
  p_time text
) RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $func$
BEGIN
  IF p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION '時刻は HH:MM 形式で入力してください: %', p_time;
  END IF;
  RETURN (p_date::text || ' ' || p_time || ':00')::timestamp AT TIME ZONE 'Asia/Tokyo';
END;
$func$;


-- ------------------------------------------------------------
-- (3) 打刻を追加(打刻もれの補完)
-- ------------------------------------------------------------
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
  v_at       timestamptz;
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

  -- 退職者の打刻もれを後から補うことがあるので is_active は問わない
  IF NOT EXISTS (
    SELECT 1 FROM nippo.staff WHERE id = p_staff_id AND store_id = v_store_id
  ) THEN
    RAISE EXCEPTION 'この店舗に所属するスタッフではありません';
  END IF;

  v_at := nippo.jst_timestamp(p_work_date, p_time);

  INSERT INTO nippo.time_clock_events (
    store_id, staff_id, work_date, event_type, event_at, source, note, edited_at
  ) VALUES (
    v_store_id, p_staff_id, p_work_date, p_event_type, v_at, 'admin', p_note, now()
  )
  RETURNING id INTO v_event_id;

  PERFORM nippo.rebuild_actual_shift(v_store_id, p_staff_id, p_work_date);

  RETURN jsonb_build_object('event_id', v_event_id);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.add_punch(text, integer, date, text, text, text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 打刻を修正(時刻・種別)
-- ------------------------------------------------------------
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
  v_store_id  int;
  v_staff_id  int;
  v_work_date date;
  v_status    text;
BEGIN
  IF p_event_type NOT IN ('clock_in','break_begin','break_end','clock_out') THEN
    RAISE EXCEPTION '不正な打刻種別です: %', p_event_type;
  END IF;

  SELECT store_id, staff_id, work_date, freee_status
    INTO v_store_id, v_staff_id, v_work_date, v_status
  FROM nippo.time_clock_events
  WHERE id = p_event_id;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '打刻が見つかりません';
  END IF;

  UPDATE nippo.time_clock_events
  SET event_type   = p_event_type,
      event_at     = nippo.jst_timestamp(v_work_date, p_time),
      note         = COALESCE(p_note, note),
      edited_at    = now(),
      -- freee に送信済みなら手作業での修正が必要
      freee_status = CASE WHEN v_status = 'sent' THEN 'manual' ELSE v_status END,
      freee_error  = CASE
                       WHEN v_status = 'sent'
                       THEN 'freee送信後に修正されました。freee側は手動で直してください'
                       ELSE freee_error
                     END
  WHERE id = p_event_id;

  PERFORM nippo.rebuild_actual_shift(v_store_id, v_staff_id, v_work_date);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.update_punch(bigint, text, text, text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (5) 打刻を削除
--     労務記録なので物理削除せず取消フラグを立てる。
--     画面上は既定で非表示になるので、利用者から見た挙動は削除と同じ。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.delete_punch(
  p_event_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id  int;
  v_staff_id  int;
  v_work_date date;
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
  WHERE id = p_event_id AND NOT is_voided
  RETURNING store_id, staff_id, work_date
  INTO v_store_id, v_staff_id, v_work_date;

  IF v_store_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM nippo.rebuild_actual_shift(v_store_id, v_staff_id, v_work_date);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.delete_punch(bigint)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (6) 削除の取り消し
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.restore_punch(
  p_event_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id  int;
  v_staff_id  int;
  v_work_date date;
BEGIN
  UPDATE nippo.time_clock_events
  SET is_voided = false,
      voided_at = NULL,
      edited_at = now(),
      -- 削除時に skipped にした分は送信対象に戻す
      freee_status = CASE WHEN freee_status = 'skipped' THEN 'pending' ELSE freee_status END
  WHERE id = p_event_id AND is_voided
  RETURNING store_id, staff_id, work_date
  INTO v_store_id, v_staff_id, v_work_date;

  IF v_store_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM nippo.rebuild_actual_shift(v_store_id, v_staff_id, v_work_date);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.restore_punch(bigint)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

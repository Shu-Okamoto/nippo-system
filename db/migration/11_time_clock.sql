-- ============================================================
-- 勤怠打刻(タイムクロック)機能
-- ------------------------------------------------------------
-- ・nippo.time_clock_events : 打刻イベントの追記専用ログ
-- ・nippo.staff.freee_employee_id : freee人事労務の従業員ID
-- ・nippo.freee_tokens : freee OAuth トークン(サーバ専用・RLSで遮断)
-- ・punch()          : 打刻を記録し、実績シフトに反映して状態を返す
-- ・get_clock_board() : 打刻画面用に全メンバーの当日状態を返す
-- ・void_punch()     : 誤打刻の取消(管理用)
--
-- 打刻は shift_entries(entry_type='actual')に自動反映されるので、
-- 既存のダッシュボード・月間レポートはそのまま実績を拾う。
--
-- 日付は日本時間(Asia/Tokyo)基準。DBのタイムゾーン設定に依存しない。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================


-- ------------------------------------------------------------
-- (1) 打刻イベントログ(追記専用)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.time_clock_events (
  id              bigserial   PRIMARY KEY,
  store_id        integer     NOT NULL REFERENCES nippo.stores(id) ON DELETE RESTRICT,
  staff_id        integer     NOT NULL REFERENCES nippo.staff(id)  ON DELETE RESTRICT,
  work_date       date        NOT NULL,
  event_type      text        NOT NULL
                              CHECK (event_type IN ('clock_in','break_begin','break_end','clock_out')),
  event_at        timestamptz NOT NULL DEFAULT now(),
  source          text        NOT NULL DEFAULT 'web',
  note            text,
  -- 誤打刻は物理削除せず取消フラグを立てる(労務記録として履歴を残す)
  is_voided       boolean     NOT NULL DEFAULT false,
  voided_at       timestamptz,
  -- freee人事労務への送信状態
  freee_status    text        NOT NULL DEFAULT 'pending'
                              CHECK (freee_status IN ('pending','sent','skipped','error')),
  freee_synced_at timestamptz,
  freee_error     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tce_store_date_idx  ON nippo.time_clock_events (store_id, work_date);
CREATE INDEX IF NOT EXISTS tce_staff_date_idx  ON nippo.time_clock_events (staff_id, work_date);
CREATE INDEX IF NOT EXISTS tce_freee_idx       ON nippo.time_clock_events (freee_status)
  WHERE freee_status = 'pending';

DROP TRIGGER IF EXISTS trg_time_clock_events_updated ON nippo.time_clock_events;
CREATE TRIGGER trg_time_clock_events_updated
  BEFORE UPDATE ON nippo.time_clock_events
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

ALTER TABLE nippo.time_clock_events DISABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- (2) staff に freee 従業員ID を追加
-- ------------------------------------------------------------
ALTER TABLE nippo.staff
  ADD COLUMN IF NOT EXISTS freee_employee_id integer;


-- ------------------------------------------------------------
-- (3) freee OAuth トークン(1行のみ)
--     アクセストークン/リフレッシュトークンを保持する。
--     anon から読めてはいけないので RLS を有効化しポリシーを作らない
--     (service_role は RLS をバイパスするのでサーバからは読める)。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nippo.freee_tokens (
  id            integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token  text        NOT NULL,
  refresh_token text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_freee_tokens_updated ON nippo.freee_tokens;
CREATE TRIGGER trg_freee_tokens_updated
  BEFORE UPDATE ON nippo.freee_tokens
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

ALTER TABLE nippo.freee_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nippo.freee_tokens FROM anon, authenticated;


-- ------------------------------------------------------------
-- (4) 打刻から実績シフトを組み立て直す
--     イベントログが唯一の真実で、shift_entries はその射影。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.rebuild_actual_shift(
  p_store_id  integer,
  p_staff_id  integer,
  p_work_date date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_report_id    int;
  v_start        time;
  v_end          time;
  v_break_start  time;
  v_break_end    time;
  v_break_min    int := 0;
  v_break_count  int := 0;
  v_shift_id     int;
BEGIN
  -- 出退勤
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

  -- 休憩: break_begin と直後の break_end をペアにして合計する
  WITH ev AS (
    SELECT event_type, event_at,
           lead(event_type) OVER (ORDER BY event_at, id) AS next_type,
           lead(event_at)   OVER (ORDER BY event_at, id) AS next_at
    FROM nippo.time_clock_events
    WHERE staff_id = p_staff_id AND work_date = p_work_date
      AND event_type IN ('break_begin','break_end') AND NOT is_voided
  ),
  pairs AS (
    SELECT event_at AS bs, next_at AS be
    FROM ev
    WHERE event_type = 'break_begin' AND next_type = 'break_end'
  )
  SELECT
    COALESCE(SUM(EXTRACT(EPOCH FROM (be - bs)) / 60)::int, 0),
    COUNT(*),
    MIN((bs AT TIME ZONE 'Asia/Tokyo')::time),
    MIN((be AT TIME ZONE 'Asia/Tokyo')::time)
  INTO v_break_min, v_break_count, v_break_start, v_break_end
  FROM pairs;

  -- 出勤打刻が無い(全部取消された等)なら実績行を消して終了
  IF v_start IS NULL THEN
    SELECT id INTO v_report_id
    FROM nippo.daily_reports
    WHERE store_id = p_store_id AND report_date = p_work_date;

    IF v_report_id IS NOT NULL THEN
      DELETE FROM nippo.shift_entries
      WHERE daily_report_id = v_report_id
        AND staff_id = p_staff_id
        AND entry_type = 'actual';
    END IF;
    RETURN;
  END IF;

  -- 日報が無ければ器だけ作る(打刻が先行するケース)
  INSERT INTO nippo.daily_reports (store_id, report_date)
  VALUES (p_store_id, p_work_date)
  ON CONFLICT (store_id, report_date) DO NOTHING;

  SELECT id INTO v_report_id
  FROM nippo.daily_reports
  WHERE store_id = p_store_id AND report_date = p_work_date;

  -- 休憩が2回以上ある場合は break_start/break_end を空にする。
  -- アプリ側の shiftMinutes() は break_start/end が両方あるとそちらを
  -- 優先して1回分しか引かないため、合計は break_minutes に持たせる。
  IF v_break_count <> 1 THEN
    v_break_start := NULL;
    v_break_end   := NULL;
  END IF;

  SELECT id INTO v_shift_id
  FROM nippo.shift_entries
  WHERE daily_report_id = v_report_id
    AND staff_id = p_staff_id
    AND entry_type = 'actual'
  ORDER BY id
  LIMIT 1;

  IF v_shift_id IS NULL THEN
    INSERT INTO nippo.shift_entries (
      daily_report_id, staff_id, staff_name_manual, entry_type,
      start_time, end_time, break_minutes, break_start, break_end
    ) VALUES (
      v_report_id, p_staff_id, NULL, 'actual',
      v_start, v_end, v_break_min, v_break_start, v_break_end
    );
  ELSE
    UPDATE nippo.shift_entries
    SET start_time    = v_start,
        end_time      = v_end,
        break_minutes = v_break_min,
        break_start   = v_break_start,
        break_end     = v_break_end
    WHERE id = v_shift_id;
  END IF;
END;
$func$;


-- ------------------------------------------------------------
-- (5) 打刻本体
--     状態遷移を検証し、イベントを追記して実績シフトに反映する。
-- ------------------------------------------------------------
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
  v_today      date := (v_now AT TIME ZONE 'Asia/Tokyo')::date;
  v_work_date  date;
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

  -- 勤務日は常に当日(JST)。営業時間が 9-17 時で日跨ぎしないため、
  -- 未退勤セッションを翌日に引き継ぐような複雑な扱いはしない。
  -- (打刻し忘れで古いセッションが残ると翌日の打刻が前日に付いてしまう)
  v_work_date := v_today;

  -- 直近の打刻種別(取消分は除く)
  SELECT event_type INTO v_last
  FROM nippo.time_clock_events
  WHERE staff_id = p_staff_id AND work_date = v_work_date AND NOT is_voided
  ORDER BY event_at DESC, id DESC
  LIMIT 1;

  -- 状態遷移の検証
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
    IF v_last <> 'break_begin' THEN
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

  PERFORM nippo.rebuild_actual_shift(v_store_id, p_staff_id, v_work_date);

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


-- ------------------------------------------------------------
-- (6) 打刻画面用のボード
--     店舗の有効スタッフ全員 × 当日の打刻状態
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
      (SELECT to_char(min(e.event_at) AT TIME ZONE 'Asia/Tokyo', 'HH24:MI')
       FROM nippo.time_clock_events e
       WHERE e.staff_id = s.id AND e.work_date = v_today
         AND e.event_type = 'clock_in' AND NOT e.is_voided)  AS clock_in_at,
      (SELECT to_char(max(e.event_at) AT TIME ZONE 'Asia/Tokyo', 'HH24:MI')
       FROM nippo.time_clock_events e
       WHERE e.staff_id = s.id AND e.work_date = v_today
         AND e.event_type = 'clock_out' AND NOT e.is_voided) AS clock_out_at,
      (SELECT COALESCE(se.break_minutes, 0)
       FROM nippo.shift_entries se
       JOIN nippo.daily_reports dr ON dr.id = se.daily_report_id
       WHERE dr.store_id = v_store_id AND dr.report_date = v_today
         AND se.staff_id = s.id AND se.entry_type = 'actual'
       LIMIT 1)                              AS break_minutes
    FROM nippo.staff s
    WHERE s.store_id = v_store_id AND s.is_active
  ) m;

  RETURN jsonb_build_object(
    'store_name', (SELECT name FROM nippo.stores WHERE id = v_store_id),
    'today',      v_today,
    'server_time', to_char(now() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI'),
    'members',    v_members
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_clock_board(text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (7) 誤打刻の取消(管理用)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.void_punch(
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
  SET is_voided = true, voided_at = now(),
      freee_status = CASE WHEN freee_status = 'pending' THEN 'skipped' ELSE freee_status END
  WHERE id = p_event_id AND NOT is_voided
  RETURNING store_id, staff_id, work_date
  INTO v_store_id, v_staff_id, v_work_date;

  IF v_store_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM nippo.rebuild_actual_shift(v_store_id, v_staff_id, v_work_date);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.void_punch(bigint)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

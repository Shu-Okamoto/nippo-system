-- ============================================================
-- 打刻一覧の取得を RPC 化 + 権限の明示付与
-- ------------------------------------------------------------
-- 症状:
--   勤怠管理画面で、上の「勤怠集計」には打刻が出るのに、
--   下の打刻一覧が「この日の打刻はありません」になり、
--   編集・削除ボタンも出ない。
--
-- 原因:
--   集計は get_attendance_summary()(SECURITY DEFINER)経由なので
--   テーブル権限に関係なく読める。一方、打刻一覧だけは
--   time_clock_events を PostgREST から直接 SELECT していた。
--   01_setup_target.sql の ALTER DEFAULT PRIVILEGES は
--   「それを実行したロールが以後に作るテーブル」にしか効かないため、
--   11_time_clock.sql を別セッション/別ロールで実行していると
--   time_clock_events に anon/authenticated の SELECT 権限が付かない。
--
-- 対処:
--   (1) 新しいテーブルに明示的に GRANT する(冪等)
--   (2) 打刻一覧も SECURITY DEFINER の RPC 経由に統一する
--       → 権限や RLS の設定に依存しなくなる
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 14_attendance_month.sql まで実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 権限を明示的に付ける
--     ALTER DEFAULT PRIVILEGES の取りこぼしを埋める。
--     既に付いていれば何も起きない。
-- ------------------------------------------------------------
GRANT USAGE ON SCHEMA nippo TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON nippo.time_clock_events TO anon, authenticated, service_role;

GRANT USAGE, SELECT
  ON SEQUENCE nippo.time_clock_events_id_seq TO anon, authenticated, service_role;

-- 打刻テーブルは RLS を使わない方針(Phase 1 と同じ)
ALTER TABLE nippo.time_clock_events DISABLE ROW LEVEL SECURITY;

-- freee のトークンだけは anon から絶対に読めてはいけないので、
-- 上の GRANT に巻き込まれていないことをここで再確認する
REVOKE ALL ON nippo.freee_tokens FROM anon, authenticated;
ALTER TABLE nippo.freee_tokens ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- (2) 打刻一覧を RPC で返す
--     画面が必要とする項目(スタッフ名を含む)をまとめて返す。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_punch_events(
  p_slug           text,
  p_date           date,
  p_include_voided boolean DEFAULT true
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

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           e.id,
      'store_id',     e.store_id,
      'staff_id',     e.staff_id,
      'staff_name',   s.name,
      'work_date',    e.work_date,
      'event_type',   e.event_type,
      'event_at',     e.event_at,
      'source',       e.source,
      'note',         e.note,
      'is_voided',    e.is_voided,
      'edited_at',    e.edited_at,
      'freee_status', e.freee_status,
      'freee_error',  e.freee_error
    ) ORDER BY e.event_at, e.id
  ), '[]'::jsonb)
  INTO v_rows
  FROM nippo.time_clock_events e
  LEFT JOIN nippo.staff s ON s.id = e.staff_id
  WHERE e.store_id = v_store_id
    AND e.work_date = p_date
    AND (p_include_voided OR NOT e.is_voided);

  RETURN jsonb_build_object('date', p_date, 'events', v_rows);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_punch_events(text, date, boolean)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- 参考: 原因の切り分けに使える確認クエリ
-- ------------------------------------------------------------
-- 打刻が実際に入っているか(ロール権限に関係なく見える)
--
-- SELECT e.id, e.work_date, e.event_type, e.event_at, e.is_voided,
--        s.name, st.slug
-- FROM nippo.time_clock_events e
-- LEFT JOIN nippo.staff  s  ON s.id  = e.staff_id
-- LEFT JOIN nippo.stores st ON st.id = e.store_id
-- ORDER BY e.event_at DESC
-- LIMIT 20;

-- anon/authenticated にテーブル権限が付いているか
--
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'nippo' AND table_name = 'time_clock_events'
-- ORDER BY grantee, privilege_type;

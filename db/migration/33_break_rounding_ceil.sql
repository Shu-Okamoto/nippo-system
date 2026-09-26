-- ============================================================
-- 休憩の丸めルールを変更(境界の扱いを1分ずらす)
-- ------------------------------------------------------------
-- 28_break_rounding_rule.sql では「区切りちょうども次に上げる」
-- としていたが、運用ルールが変わった。
--
--   旧: 45〜59分 → 60分  (45ちょうども60に上がる)
--   新: 46〜60分 → 60分  (45ちょうどは45のまま)
--
-- 新しい区分。素直な15分切り上げになる。
--
--    1〜15分 → 15分
--   16〜30分 → 30分
--   31〜45分 → 45分
--   46〜60分 → 60分
--   61〜75分 → 75分
--
--   旧: (FLOOR(45/15)+1)*15 = 60
--   新: CEIL(45/15)*15      = 45
--
-- 休憩0分は0分のまま。休憩を取っていない日を15分にはしない。
-- 出勤(切り上げ)・退勤(切り捨て)は変更しない。
--
-- この関数は clock_summary と実績エクスポートの両方から呼ばれるので、
-- ここを差し替えるだけで画面・freee送信の実働が揃って変わる。
-- 過去分も再計算されるため、freee へ送信済みの勤務実績は
-- 必要なら再送信(work_records は PUT で冪等)して合わせる。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 28_break_rounding_rule.sql 実行済み
-- ============================================================

CREATE OR REPLACE FUNCTION nippo.round_break_minutes(p_min integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $func$
  SELECT CASE
    WHEN COALESCE(p_min, 0) <= 0 THEN 0
    ELSE CEIL(p_min::numeric / 15)::int * 15
  END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.round_break_minutes(integer)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- 確認用。期待値と一致するはず
--   0→0, 1→15, 15→15, 16→30, 30→30, 31→45,
--   45→45, 46→60, 60→60, 61→75
-- ------------------------------------------------------------
-- SELECT m, nippo.round_break_minutes(m)
-- FROM unnest(ARRAY[0,1,15,16,30,31,45,46,60,61]) AS m;

NOTIFY pgrst, 'reload schema';

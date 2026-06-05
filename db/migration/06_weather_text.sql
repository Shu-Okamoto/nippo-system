-- ============================================================
-- weather を自由テキストとして許容するため CHECK 制約を外す
-- ------------------------------------------------------------
-- dx."Sale".weather は自由テキストで、'sunny'/'cloudy' 等の
-- 固定 4 値とは限らない。daily_reports.weather に dx 値を
-- そのまま保存できるように CHECK 制約を削除する。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================

ALTER TABLE nippo.daily_reports
  DROP CONSTRAINT IF EXISTS daily_reports_weather_check;

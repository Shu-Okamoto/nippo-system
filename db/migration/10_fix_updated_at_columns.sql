-- ============================================================
-- updated_at 列の欠落を修復
-- ------------------------------------------------------------
-- 症状: 商品マスタの停止/復帰(UPDATE)で
--   「record "new" has no field "updated_at"」
--
-- 原因: 移行時に旧定義のテーブルが既に存在していたため
--   01_setup_target.sql の CREATE TABLE IF NOT EXISTS がスキップされ、
--   updated_at 列が無いまま set_updated_at トリガだけが貼られた。
--
-- 対処: 全テーブルに updated_at を冪等に追加する。
--   既に列があるテーブルは何も起きない。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================

ALTER TABLE nippo.stores           ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.staff            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.products         ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.daily_reports    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.shift_entries    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.order_lines      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.report_questions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE nippo.report_answers   ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- freee従業員ID を文字列に変更
-- ------------------------------------------------------------
-- freee の画面に出る従業員番号は "000015" のようにゼロ埋めされている。
-- integer だと先頭のゼロが落ちて入力どおりに保存できないため text にする。
--
-- 送信時は数値化せずそのまま API のパスに渡す。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================

ALTER TABLE nippo.staff
  ALTER COLUMN freee_employee_id TYPE text
  USING NULLIF(btrim(freee_employee_id::text), '');

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 動的日報項目(質問マスタ + 回答テーブル)を導入
-- ------------------------------------------------------------
-- ・nippo.report_questions : 質問マスタ(全店共通)
-- ・nippo.report_answers   : 日報ごとの回答
-- ・気づき/備考は質問マスタの初期シードとして登録
-- ・save_daily_report_full に p_answers パラメータを追加
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- ============================================================


-- (1) 質問マスタ
CREATE TABLE IF NOT EXISTS nippo.report_questions (
  id            serial      PRIMARY KEY,
  question      text        NOT NULL,
  input_type    text        NOT NULL
                            CHECK (input_type IN ('text','textarea','number','checkbox')),
  sort_order    integer     NOT NULL DEFAULT 0,
  is_active     boolean     NOT NULL DEFAULT true,
  initial_value text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_report_questions_updated ON nippo.report_questions;
CREATE TRIGGER trg_report_questions_updated
  BEFORE UPDATE ON nippo.report_questions
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

ALTER TABLE nippo.report_questions DISABLE ROW LEVEL SECURITY;


-- (2) 回答テーブル
CREATE TABLE IF NOT EXISTS nippo.report_answers (
  id              serial      PRIMARY KEY,
  daily_report_id integer     NOT NULL REFERENCES nippo.daily_reports(id) ON DELETE CASCADE,
  question_id     integer     NOT NULL REFERENCES nippo.report_questions(id) ON DELETE CASCADE,
  answer_text     text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (daily_report_id, question_id)
);

CREATE INDEX IF NOT EXISTS report_answers_report_idx
  ON nippo.report_answers (daily_report_id);

DROP TRIGGER IF EXISTS trg_report_answers_updated ON nippo.report_answers;
CREATE TRIGGER trg_report_answers_updated
  BEFORE UPDATE ON nippo.report_answers
  FOR EACH ROW EXECUTE FUNCTION nippo.set_updated_at();

ALTER TABLE nippo.report_answers DISABLE ROW LEVEL SECURITY;


-- (3) 初期シード: 「気づき」「備考」を質問として登録
INSERT INTO nippo.report_questions (question, input_type, sort_order, is_active)
VALUES
  ('気づき', 'textarea', 10, true),
  ('備考',   'textarea', 20, true)
ON CONFLICT DO NOTHING;


-- (4) save_daily_report_full に p_answers パラメータを追加
DROP FUNCTION IF EXISTS nippo.save_daily_report_full(
  text, text, text, integer, integer, integer,
  text, text, text, text, text, jsonb, jsonb
);

CREATE OR REPLACE FUNCTION nippo.save_daily_report_full(
  p_slug           text,
  p_weather        text     DEFAULT NULL,
  p_event_note     text     DEFAULT NULL,
  p_sales_forecast integer  DEFAULT NULL,
  p_sales_actual   integer  DEFAULT NULL,
  p_customer_count integer  DEFAULT NULL,
  p_sozai_zan      text     DEFAULT NULL,
  p_mochi_zan      text     DEFAULT NULL,
  p_report_text    text     DEFAULT NULL,
  p_kizuki         text     DEFAULT NULL,
  p_bikou          text     DEFAULT NULL,
  p_shifts         jsonb    DEFAULT '[]'::jsonb,
  p_orders         jsonb    DEFAULT '[]'::jsonb,
  p_answers        jsonb    DEFAULT '[]'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id   int;
  v_report_id  int;
  v_today      date := CURRENT_DATE;
  v_shift      jsonb;
  v_order      jsonb;
  v_answer     jsonb;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  INSERT INTO nippo.daily_reports (
    store_id, report_date, weather, event_note,
    sales_forecast, sales_actual, customer_count,
    sozai_zan, mochi_zan,
    report_text, kizuki, bikou
  ) VALUES (
    v_store_id, v_today, p_weather, p_event_note,
    p_sales_forecast, p_sales_actual, p_customer_count,
    p_sozai_zan, p_mochi_zan,
    p_report_text, p_kizuki, p_bikou
  )
  ON CONFLICT (store_id, report_date) DO UPDATE SET
    weather        = EXCLUDED.weather,
    event_note     = EXCLUDED.event_note,
    sales_forecast = EXCLUDED.sales_forecast,
    sales_actual   = EXCLUDED.sales_actual,
    customer_count = EXCLUDED.customer_count,
    sozai_zan      = EXCLUDED.sozai_zan,
    mochi_zan      = EXCLUDED.mochi_zan,
    report_text    = EXCLUDED.report_text,
    kizuki         = EXCLUDED.kizuki,
    bikou          = EXCLUDED.bikou
  RETURNING id INTO v_report_id;

  DELETE FROM nippo.shift_entries WHERE daily_report_id = v_report_id;
  FOR v_shift IN SELECT * FROM jsonb_array_elements(p_shifts)
  LOOP
    INSERT INTO nippo.shift_entries (
      daily_report_id, staff_id, staff_name_manual,
      entry_type, pattern,
      start_time, end_time,
      break_minutes, break_start, break_end
    ) VALUES (
      v_report_id,
      NULLIF(v_shift->>'staff_id', '')::int,
      v_shift->>'staff_name_manual',
      v_shift->>'entry_type',
      v_shift->>'pattern',
      NULLIF(v_shift->>'start_time', '')::time,
      NULLIF(v_shift->>'end_time', '')::time,
      COALESCE(NULLIF(v_shift->>'break_minutes','')::int, 0),
      NULLIF(v_shift->>'break_start', '')::time,
      NULLIF(v_shift->>'break_end', '')::time
    );
  END LOOP;

  DELETE FROM nippo.order_lines WHERE daily_report_id = v_report_id;
  FOR v_order IN SELECT * FROM jsonb_array_elements(p_orders)
  LOOP
    INSERT INTO nippo.order_lines (
      daily_report_id, product_id, item_name_manual, planned_qty
    ) VALUES (
      v_report_id,
      NULLIF(v_order->>'product_id', '')::int,
      v_order->>'item_name_manual',
      COALESCE(NULLIF(v_order->>'planned_qty','')::int, 0)
    );
  END LOOP;

  -- 動的回答を upsert(空文字や NULL は記録しない)
  FOR v_answer IN SELECT * FROM jsonb_array_elements(p_answers)
  LOOP
    INSERT INTO nippo.report_answers (daily_report_id, question_id, answer_text)
    VALUES (
      v_report_id,
      (v_answer->>'question_id')::int,
      v_answer->>'answer_text'
    )
    ON CONFLICT (daily_report_id, question_id) DO UPDATE SET
      answer_text = EXCLUDED.answer_text;
  END LOOP;
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.save_daily_report_full(
  text, text, text, integer, integer, integer,
  text, text, text, text, text, jsonb, jsonb, jsonb
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

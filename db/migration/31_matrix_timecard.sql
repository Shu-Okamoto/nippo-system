-- ============================================================
-- 月別(店舗)ビューをタイムカード表示に対応させる
-- ------------------------------------------------------------
-- メンバーが数名なら列に余裕があるので、実働時間だけでなく
-- 出退勤・休憩もセルに出せる。
--
-- セルを数値(分)から、明細を持つオブジェクトに変える。
--   { start, end, break, breaks, work }
-- breaks は休憩の入り/戻りの配列。1日に複数回あり得る。
--
-- 時刻は打刻そのまま、work は15分丸め後。
-- 日別ビューや月別(メンバー)と同じ扱いにする。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 30_attendance_month_matrix.sql 実行済み
-- ============================================================

CREATE OR REPLACE FUNCTION nippo.get_attendance_month_matrix(
  p_slug text,
  p_from date,
  p_to   date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id  int;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  IF p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION '期間の指定が不正です(2か月以内)';
  END IF;

  RETURN (
    WITH d AS (
      SELECT generate_series(p_from, p_to, interval '1 day')::date AS work_date
    ),
    m AS (
      SELECT DISTINCT s.id, s.name, s.sort_order
      FROM nippo.staff s
      WHERE s.store_id = v_store_id
        AND EXISTS (
          SELECT 1 FROM nippo.time_clock_events e
          WHERE e.staff_id = s.id
            AND e.work_date BETWEEN p_from AND p_to
            AND NOT e.is_voided
        )
    ),
    cell AS (
      SELECT
        m.id AS staff_id, m.name, m.sort_order,
        d.work_date,
        cs.start_time,
        cs.end_time,
        cs.break_minutes,
        cs.work_minutes,
        cs.breaks
      FROM m
      CROSS JOIN d
      JOIN LATERAL nippo.clock_summary(m.id, d.work_date) cs ON true
    ),
    day_total AS (
      SELECT work_date, COALESCE(SUM(work_minutes), 0)::int AS total_min
      FROM cell GROUP BY work_date
    ),
    sales AS (
      SELECT dr.report_date, dr.sales_actual
      FROM nippo.daily_reports dr
      WHERE dr.store_id = v_store_id
        AND dr.report_date BETWEEN p_from AND p_to
    ),
    ninjibai AS (
      SELECT dt.work_date,
             CASE WHEN s.sales_actual IS NOT NULL AND dt.total_min > 0
                  THEN ROUND(s.sales_actual / (dt.total_min / 60.0))::int
                  ELSE NULL END AS nb
      FROM day_total dt
      LEFT JOIN sales s ON s.report_date = dt.work_date
    ),
    member_rows AS (
      SELECT
        c.staff_id,
        c.name,
        c.sort_order,
        -- セルは明細つき。時刻は打刻そのまま、work は丸め後
        jsonb_agg(
          jsonb_build_object(
            'start', to_char(c.start_time, 'HH24:MI'),
            'end',   to_char(c.end_time,   'HH24:MI'),
            'break', c.break_minutes,
            'breaks', c.breaks,
            'work',  COALESCE(c.work_minutes, 0)
          ) ORDER BY c.work_date
        ) AS cells,
        COALESCE(SUM(c.work_minutes), 0)::int AS total_minutes,
        COUNT(*) FILTER (WHERE c.work_minutes > 0)::int AS work_days,
        CASE
          WHEN COALESCE(SUM(
                 CASE WHEN c.work_minutes > 0 AND n.nb IS NOT NULL
                      THEN c.work_minutes ELSE 0 END), 0) > 0
          THEN ROUND(
                 SUM(CASE WHEN c.work_minutes > 0 AND n.nb IS NOT NULL
                          THEN n.nb::numeric * c.work_minutes ELSE 0 END)
                 / SUM(CASE WHEN c.work_minutes > 0 AND n.nb IS NOT NULL
                            THEN c.work_minutes ELSE 0 END)
               )::int
          ELSE NULL
        END AS avg_ninjibai
      FROM cell c
      LEFT JOIN ninjibai n ON n.work_date = c.work_date
      GROUP BY c.staff_id, c.name, c.sort_order
    )
    SELECT jsonb_build_object(
      'days', (SELECT COALESCE(jsonb_agg(work_date ORDER BY work_date), '[]'::jsonb) FROM d),
      'members', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'staff_id',      staff_id,
            'name',          name,
            'cells',         cells,
            'total_minutes', total_minutes,
            'work_days',     work_days,
            'avg_ninjibai',  avg_ninjibai
          ) ORDER BY total_minutes DESC, sort_order
        ), '[]'::jsonb)
        FROM member_rows
      ),
      'day_totals', (
        SELECT COALESCE(jsonb_agg(total_min ORDER BY work_date), '[]'::jsonb) FROM day_total
      ),
      'grand_total_minutes', (SELECT COALESCE(SUM(total_min), 0)::int FROM day_total),
      'store_ninjibai', (
        SELECT CASE WHEN SUM(dt.total_min) > 0 AND SUM(s.sales_actual) IS NOT NULL
                    THEN ROUND(SUM(s.sales_actual) / (SUM(dt.total_min) / 60.0))::int
                    ELSE NULL END
        FROM day_total dt LEFT JOIN sales s ON s.report_date = dt.work_date
      )
    )
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_attendance_month_matrix(text, date, date)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

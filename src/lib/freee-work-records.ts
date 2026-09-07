// 勤務実績の送信本体(サーバ専用)。
// 手動送信(/api/freee/sync-work-records)と自動送信(/api/cron/freee-daily)の
// どちらからも使う。処理を1か所にまとめて、丸めの扱いがずれないようにする。

import { SupabaseClient } from '@supabase/supabase-js';
import { putWorkRecord } from '@/lib/freee';

export type WorkRecordResult = {
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
  total: number;
  truncated: boolean;
};

// 1回の実行で送る上限。タイムアウトを避けるため
const LIMIT = 100;

/**
 * 期間内の勤怠を freee の勤務実績として送る。
 *
 * 送るのは丸め後の値。勤務実績は1日の労働時間そのものなので、
 * 月別ビューに出している実働と一致していないと給与計算が合わない。
 * (打刻 time_clocks 側は実打刻をそのまま送る)
 */
export async function pushWorkRecords(
  sb: SupabaseClient<any, any, any, any, any>,
  accessToken: string,
  slug: string,
  from: string,
  to: string
): Promise<WorkRecordResult> {
  const { data, error } = await sb.rpc('get_attendance_export', {
    p_slug: slug,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`勤怠の取得に失敗しました: ${error.message}`);

  const rows = ((data as any)?.rows ?? []) as any[];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const r of rows.slice(0, LIMIT)) {
    const start = r.rounded_start_time;
    const end = r.rounded_end_time;

    // 従業員ID未設定、出退勤が揃っていない、丸めた結果 退勤 <= 出勤
    // (1分だけの打刻など)は送れない
    if (!r.freee_employee_id || !start || !end || r.work_minutes === null) {
      skipped++;
      continue;
    }

    const firstBreak =
      Array.isArray(r.breaks) && r.breaks.length > 0 ? r.breaks[0]?.begin ?? null : null;

    try {
      await putWorkRecord(
        accessToken,
        String(r.freee_employee_id),
        r.date,
        start,
        end,
        r.rounded_break_minutes ?? 0,
        firstBreak
      );
      sent++;
    } catch (err: any) {
      failed++;
      if (errors.length < 10) {
        errors.push(`${r.staff_name} ${r.date}: ${String(err?.message ?? err).slice(0, 500)}`);
      }
    }
  }

  return {
    sent,
    skipped,
    failed,
    errors,
    total: rows.length,
    truncated: rows.length > LIMIT,
  };
}

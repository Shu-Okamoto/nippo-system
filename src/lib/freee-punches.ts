// 打刻の送信本体(サーバ専用)。
// 手動送信(/api/freee/sync)と自動送信(/api/cron/freee-daily)の
// どちらからも使う。

import { SupabaseClient } from '@supabase/supabase-js';
import { postTimeClock, toJstDateTime, type FreeeClockType } from '@/lib/freee';

export type PunchResult = {
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
};

// 1回の実行で送る上限。タイムアウトを避けるため
const BATCH_LIMIT = 50;

/**
 * 未送信の打刻を freee に送る。
 *
 * 打刻は「実際に押した時刻」をそのまま送る。丸めるのは勤務実績側の役割。
 *
 * workDate を指定すると、その日の打刻だけを対象にする。
 * 自動送信では当日分に絞る。freee の打刻APIは過去日を受け付けないため、
 * 溜まった過去分まで送ろうとしても失敗が増えるだけになる。
 */
export async function pushPendingPunches(
  sb: SupabaseClient<any, any, any, any, any>,
  accessToken: string,
  workDate?: string
): Promise<PunchResult> {
  let q = sb
    .from('time_clock_events')
    .select('id, staff_id, work_date, event_type, event_at, staff(name, freee_employee_id)')
    .eq('freee_status', 'pending')
    .eq('is_voided', false);

  if (workDate) q = q.eq('work_date', workDate);

  // 打刻は順序が意味を持つ(出勤→休憩入→休憩戻→退勤)ので時刻順に送る
  const { data: events, error } = await q.order('event_at').limit(BATCH_LIMIT);

  if (error) throw new Error(`打刻の取得に失敗しました: ${error.message}`);
  if (!events || events.length === 0) {
    return { sent: 0, skipped: 0, failed: 0, errors: [] };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const ev of events as any[]) {
    const employeeId: string | null = ev.staff?.freee_employee_id ?? null;

    // freee 従業員IDが未設定のスタッフは送りようがないので skipped にする。
    // (スタッフマスタで ID を設定したら、その後の打刻から送られる)
    if (!employeeId) {
      await sb
        .from('time_clock_events')
        .update({
          freee_status: 'skipped',
          freee_error: 'freee従業員IDが未設定です',
          freee_synced_at: new Date().toISOString(),
        })
        .eq('id', ev.id);
      skipped++;
      continue;
    }

    const { baseDate, datetime } = toJstDateTime(ev.event_at);

    try {
      await postTimeClock(
        accessToken,
        String(employeeId),
        ev.event_type as FreeeClockType,
        baseDate,
        datetime
      );
      await sb
        .from('time_clock_events')
        .update({
          freee_status: 'sent',
          freee_error: null,
          freee_synced_at: new Date().toISOString(),
        })
        .eq('id', ev.id);
      sent++;
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 500);
      await sb
        .from('time_clock_events')
        .update({
          freee_status: 'error',
          freee_error: msg,
          freee_synced_at: new Date().toISOString(),
        })
        .eq('id', ev.id);
      failed++;
      if (errors.length < 5) errors.push(`${ev.staff?.name ?? ev.staff_id}: ${msg}`);
    }
  }

  return { sent, skipped, failed, errors };
}

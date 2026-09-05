// 未送信の打刻イベントを freee人事労務 に送る。
//
// 呼び出し方:
//   POST /api/freee/sync
//     ヘッダ x-cron-secret: <CRON_SECRET>            (Vercel Cron 等から)
//     または Authorization: Bearer <Supabaseのアクセストークン>  (管理画面から)
//   GET  /api/freee/sync   … 設定状況と未送信件数を返す(認証同上)
//
// 認証を必須にしているのは、このエンドポイントが人事データを外部に
// 送信するため。誰でも叩ける状態にはしない。

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccessToken,
  isConnected,
  isFreeeConfigured,
  postTimeClock,
  serviceClient,
  toJstDateTime,
  type FreeeClockType,
} from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 1回の実行で送る上限。タイムアウトを避けるため
const BATCH_LIMIT = 50;

async function authorize(req: NextRequest): Promise<string | null> {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get('x-cron-secret');
  if (secret && given && given === secret) return null;

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    try {
      const sb = serviceClient();
      const { data, error } = await sb.auth.getUser(token);
      if (!error && data?.user) return null;
    } catch {
      // 下の 401 に落とす
    }
  }
  return 'この URL はブラウザで直接開けません。管理画面(勤怠管理)から実行するか、定期実行の場合は x-cron-secret ヘッダを付けてください';
}

export async function GET(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  if (!isFreeeConfigured()) {
    return NextResponse.json({ configured: false, pending: 0, message: 'freee 連携は未設定です' });
  }

  const sb = serviceClient();
  const [{ count: pending }, { count: errored }, connected] = await Promise.all([
    sb.from('time_clock_events').select('id', { count: 'exact', head: true })
      .eq('freee_status', 'pending').eq('is_voided', false),
    sb.from('time_clock_events').select('id', { count: 'exact', head: true })
      .eq('freee_status', 'error'),
    isConnected(sb),
  ]);

  return NextResponse.json({
    configured: true,
    connected,
    pending: pending ?? 0,
    errored: errored ?? 0,
  });
}

export async function POST(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  if (!isFreeeConfigured()) {
    return NextResponse.json(
      { configured: false, message: 'freee 連携は未設定です(環境変数を設定してください)' },
      { status: 200 }
    );
  }

  const sb = serviceClient();

  const { data: events, error: e1 } = await sb
    .from('time_clock_events')
    .select('id, staff_id, work_date, event_type, event_at, staff(name, freee_employee_id)')
    .eq('freee_status', 'pending')
    .eq('is_voided', false)
    .order('event_at')
    .limit(BATCH_LIMIT);

  if (e1) {
    return NextResponse.json({ error: `打刻の取得に失敗しました: ${e1.message}` }, { status: 500 });
  }
  if (!events || events.length === 0) {
    return NextResponse.json({ configured: true, sent: 0, skipped: 0, failed: 0 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sb);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
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

  return NextResponse.json({ configured: true, sent, skipped, failed, errors });
}

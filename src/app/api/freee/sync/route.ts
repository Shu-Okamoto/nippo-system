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
  serviceClient,
} from '@/lib/freee';
import { pushPendingPunches } from '@/lib/freee-punches';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sb);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }

  // 当日分だけを送る。freee の打刻APIは過去日を受け付けず
  // 「打刻の時間が正しくありません」で弾かれるため。
  // 過去分は勤務実績(work_records)側で送る
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  try {
    const result = await pushPendingPunches(sb, accessToken, today);
    return NextResponse.json({ configured: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

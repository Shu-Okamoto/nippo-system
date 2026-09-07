// 期間内の勤怠を freee の勤務実績(work_records)として送る。
//
//   POST /api/freee/sync-work-records
//     Authorization: Bearer <Supabaseのアクセストークン>
//     { "slug": "nishi", "from": "2026-09-01", "to": "2026-09-30" }
//
// 打刻API(time_clocks)は当日の打刻を順に積む仕組みで、過去日を
// まとめて登録する用途には向かない。過去分はこちらを使う。
//
// PUT なので同じ日に何度実行しても結果は同じ。途中で失敗しても
// もう一度流せばよい。

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccessToken,
  isConnected,
  isFreeeConfigured,
  putWorkRecord,
  serviceClient,
} from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 1回の実行で送る上限。タイムアウトを避けるため
const LIMIT = 100;

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json(
      {
        error: '認証が必要です',
        hint: '管理画面(勤怠管理)にログインした状態で実行してください',
      },
      { status: 401 }
    );
  }

  if (!isFreeeConfigured()) {
    return NextResponse.json({ error: 'freee の環境変数が未設定です' }, { status: 400 });
  }

  const sb = serviceClient();
  const { data: user, error: authError } = await sb.auth.getUser(token);
  if (authError || !user?.user) {
    return NextResponse.json({ error: 'ログインの有効期限が切れています' }, { status: 401 });
  }
  if (!(await isConnected(sb))) {
    return NextResponse.json({ error: 'freee と未接続です' }, { status: 400 });
  }

  let body: { slug?: string; from?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'リクエストの形式が不正です' }, { status: 400 });
  }
  if (!body.slug || !body.from || !body.to) {
    return NextResponse.json({ error: '店舗と期間を指定してください' }, { status: 400 });
  }

  const { data: exported, error: e1 } = await sb.rpc('get_attendance_export', {
    p_slug: body.slug,
    p_from: body.from,
    p_to: body.to,
  });
  if (e1) {
    return NextResponse.json({ error: `勤怠の取得に失敗しました: ${e1.message}` }, { status: 500 });
  }

  const rows = ((exported as any)?.rows ?? []) as any[];
  if (rows.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, failed: 0, errors: [] });
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

  for (const r of rows.slice(0, LIMIT)) {
    // 従業員ID未設定、または出退勤が揃っていない日は送れない
    if (!r.freee_employee_id || !r.start_time || !r.end_time) {
      skipped++;
      continue;
    }
    try {
      await putWorkRecord(
        accessToken,
        String(r.freee_employee_id),
        r.date,
        r.start_time,
        r.end_time,
        (r.breaks ?? []) as { begin: string; end: string | null }[]
      );
      sent++;
    } catch (err: any) {
      failed++;
      if (errors.length < 10) {
        errors.push(`${r.staff_name} ${r.date}: ${String(err?.message ?? err).slice(0, 500)}`);
      }
    }
  }

  return NextResponse.json({
    sent,
    skipped,
    failed,
    errors,
    total: rows.length,
    truncated: rows.length > LIMIT,
  });
}

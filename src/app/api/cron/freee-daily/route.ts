// 当日分の勤務実績を freee に自動送信する(Vercel Cron から呼ばれる)。
//
//   GET /api/cron/freee-daily
//     Authorization: Bearer <CRON_SECRET>   (Vercel Cron が自動で付ける)
//     または x-cron-secret: <CRON_SECRET>   (手動テスト用)
//
// 閉店後に走らせる想定。打刻し忘れの送信もれを防ぐため、
// 手動でボタンを押さなくてもその日の勤務実績が freee に入る。
//
// 勤務実績は PUT なので、同じ日に何度実行しても結果は同じ。
// 手動送信と併用しても二重登録にならない。

import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken, isConnected, isFreeeConfigured, serviceClient } from '@/lib/freee';
import { pushWorkRecords } from '@/lib/freee-work-records';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// 店舗数ぶん freee を叩くので長めに取る
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けてくる
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${secret}`) return true;

  return req.headers.get('x-cron-secret') === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  if (!isFreeeConfigured()) {
    return NextResponse.json({ skipped: 'freee 未設定' });
  }

  const sb = serviceClient();
  if (!(await isConnected(sb))) {
    return NextResponse.json({ skipped: 'freee 未接続' });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sb);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const { data: slugs, error } = await sb.rpc('get_active_store_slugs');
  if (error) {
    return NextResponse.json({ error: `店舗を取得できません: ${error.message}` }, { status: 500 });
  }

  const results: Record<string, unknown> = {};
  for (const slug of ((slugs ?? []) as string[])) {
    try {
      results[slug] = await pushWorkRecords(sb, accessToken, slug, today, today);
    } catch (err: any) {
      results[slug] = { error: String(err?.message ?? err).slice(0, 500) };
    }
  }

  return NextResponse.json({ date: today, results });
}

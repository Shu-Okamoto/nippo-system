// freee 連携の切り分け用。実際には打刻を送らず、送信内容と
// freee 側の受け入れ状態を確認する。
//
//   GET /api/freee/diag
//     Authorization: Bearer <Supabaseのアクセストークン>
//
// available_types は「その従業員が今どの打刻を打てるか」を返すので、
// 従業員ID・事業所ID・スコープ・認証がまとめて検証できる。

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccessToken,
  getAvailableTypes,
  getHrMe,
  grantedScope,
  isConnected,
  isFreeeConfigured,
  probeCompany,
  serviceClient,
  toJstDateTime,
} from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json(
      {
        error: '認証が必要です',
        hint:
          'この URL はブラウザで直接開けません。' +
          '管理画面(勤怠管理)にログインした状態で、画面上のボタンから実行してください',
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
    return NextResponse.json(
      {
        error: 'ログインの有効期限が切れています',
        hint: '管理画面でログインし直してから、もう一度実行してください',
      },
      { status: 401 }
    );
  }

  if (!(await isConnected(sb))) {
    return NextResponse.json({ error: 'freee と未接続です' }, { status: 400 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sb);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }

  // 最初に人事労務APIそのものに到達できるかを見る。
  // ここが 403 ならアプリに人事労務の権限が付いていない
  const hrMe = await getHrMe(accessToken);
  if (!hrMe.ok) {
    return NextResponse.json({
      hr_access: {
        ok: false,
        status: hrMe.status,
        response: hrMe.body,
        hint:
          '人事労務APIに到達できていません。freee アプリの設定で人事労務の' +
          '権限が有効か、事業所で人事労務が使える状態かを確認してください。' +
          'スコープの指定が必要な場合は FREEE_SCOPE を設定して接続し直します。',
      },
      scope_sent: process.env.FREEE_SCOPE ?? '(未設定)',
      company_id: process.env.FREEE_COMPANY_ID,
    });
  }

  // トークンがどの事業所で有効かを特定する。
  // freee のトークンは認可時に選んだ事業所に紐づくため、users/me に
  // 出ていても認可先でなければ invalid_authorization_company_id になる
  const listed: any[] = (hrMe.body as any)?.companies ?? [];
  const companyChecks = [];
  for (const c of listed) {
    const r = await probeCompany(accessToken, c.id);
    companyChecks.push({
      id: c.id,
      name: c.name,
      accessible: r.ok,
      status: r.status,
      message: r.message,
      is_configured: String(c.id) === String(process.env.FREEE_COMPANY_ID),
    });
  }
  const usable = companyChecks.filter((c) => c.accessible);
  const configuredOk = companyChecks.find((c) => c.is_configured)?.accessible ?? false;

  if (!configuredOk) {
    return NextResponse.json({
      hr_access: { ok: true },
      company_id: process.env.FREEE_COMPANY_ID,
      companies: companyChecks,
      problem:
        usable.length > 0
          ? `FREEE_COMPANY_ID (${process.env.FREEE_COMPANY_ID}) にこのトークンでアクセスできません。` +
            `このトークンで使える事業所は ${usable
              .map((c) => `${c.name}(${c.id})`)
              .join(' / ')} です。` +
            'FREEE_COMPANY_ID をその ID に変えるか、使いたい事業所を選んで認可し直してください。'
          : 'このトークンではどの事業所にもアクセスできません。' +
            '認可し直す際に、使いたい事業所を選択してください。',
    });
  }

  // freee従業員IDが設定されているスタッフを対象にする
  const { data: staff } = await sb
    .from('staff')
    .select('id, name, freee_employee_id')
    .not('freee_employee_id', 'is', null);

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const checks: any[] = [];
  for (const s of ((staff || []) as any[]).slice(0, 20)) {
    try {
      const r = await getAvailableTypes(accessToken, String(s.freee_employee_id), today);
      checks.push({
        staff: s.name,
        freee_employee_id: s.freee_employee_id,
        ok: r.ok,
        status: r.status,
        response: r.body,
      });
    } catch (e: any) {
      checks.push({
        staff: s.name,
        freee_employee_id: s.freee_employee_id,
        ok: false,
        error: e.message,
      });
    }
  }

  // 次に送られる予定の打刻から、実際の送信内容を組み立てて見せる
  const { data: nextEvent } = await sb
    .from('time_clock_events')
    .select('id, event_type, event_at, staff(name, freee_employee_id)')
    .eq('freee_status', 'pending')
    .eq('is_voided', false)
    .order('event_at')
    .limit(1)
    .maybeSingle();

  let samplePayload: unknown = null;
  if (nextEvent) {
    const ev = nextEvent as any;
    const { baseDate, datetime } = toJstDateTime(ev.event_at);
    samplePayload = {
      url: `/hr/api/v1/employees/${ev.staff?.freee_employee_id ?? '(未設定)'}/time_clocks`,
      body: {
        company_id: Number(process.env.FREEE_COMPANY_ID),
        type: ev.event_type,
        base_date: baseDate,
        datetime,
      },
      staff: ev.staff?.name,
    };
  }

  // 全員 403 なら個々の従業員IDの問題ではなく、打刻APIを使う権限
  // (スコープ)が認可されていない可能性が高い
  const allForbidden =
    checks.length > 0 && checks.every((c) => c.status === 403);

  return NextResponse.json({
    hr_access: { ok: true },
    scope_requested: process.env.FREEE_SCOPE ?? '(未設定)',
    scope_granted: (await grantedScope(sb)) ?? '(不明。接続し直すと記録されます)',
    company_id: process.env.FREEE_COMPANY_ID,
    companies: companyChecks,
    date: today,
    available_types: checks,
    next_punch: samplePayload,
    ...(allForbidden
      ? {
          problem:
            '事業所へのアクセスは通っていますが、打刻APIが全員 403 です。' +
            '個々の従業員IDの問題ではなく、打刻を扱う権限が認可されて' +
            'いない可能性が高いです。freee 開発者ページでアプリの権限に' +
            '打刻(勤怠)が含まれているか確認し、必要なスコープを' +
            'FREEE_SCOPE に設定して再デプロイのうえ、認可し直してください。',
        }
      : {}),
  });
}

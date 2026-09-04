// freee人事労務の従業員一覧を返す。
// スタッフマスタに freee 従業員ID を転記するための補助。
//
//   GET /api/freee/employees
//     Authorization: Bearer <Supabaseのアクセストークン>

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccessToken,
  isConnected,
  isFreeeConfigured,
  listEmployees,
  serviceClient,
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

  try {
    const accessToken = await getAccessToken(sb);
    const raw: any = await listEmployees(accessToken);

    // freee のレスポンス形は環境によって差があるため、配列の位置を吸収する
    const list: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.employees)
      ? raw.employees
      : [];

    return NextResponse.json({
      employees: list.map((e) => ({
        id: e.id,
        name: e.display_name ?? e.name ?? `ID:${e.id}`,
        num: e.num ?? null,
      })),
      // 形が変わっていた場合に画面から気付けるようにしておく
      unparsed: list.length === 0 ? raw : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

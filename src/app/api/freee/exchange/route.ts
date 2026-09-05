// 認可コードを手で貼り付けてトークンに交換する。
//
//   POST /api/freee/exchange
//     Authorization: Bearer <Supabaseのアクセストークン>
//     { "code": "...", "redirect_uri": "..." }
//
// freee アプリのコールバックURLが urn:ietf:wg:oauth:2.0:oob になって
// いる場合、認可後にリダイレクトされず画面に認可コードが表示される。
// その場合は自動のコールバック(/api/freee/callback)を通らないので、
// ここに貼って交換する。
//
// redirect_uri は認可時に使ったものと完全に一致している必要がある。
// 省略時は oob とみなす。

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode, isFreeeConfigured, OOB_REDIRECT, serviceClient } from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    return NextResponse.json(
      { error: 'ログインの有効期限が切れています' },
      { status: 401 }
    );
  }

  let body: { code?: string; redirect_uri?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'リクエストの形式が不正です' }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: '認可コードを入力してください' }, { status: 400 });
  }

  const redirect = body.redirect_uri?.trim() || OOB_REDIRECT;

  try {
    await exchangeCode(sb, code, redirect);
  } catch (e: any) {
    return NextResponse.json(
      {
        error: e.message,
        hint:
          '認可コードは数分で失効し、一度しか使えません。' +
          'エラーが続く場合は freee で認可をやり直して新しいコードを取得してください。' +
          'また、認可時に使ったコールバックURLとここで指定した値が' +
          `完全に一致している必要があります(今回指定: ${redirect})`,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, redirect_uri: redirect });
}

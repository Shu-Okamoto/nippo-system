// freee との接続を開始する。ブラウザで開くと freee の認可画面に飛ぶ。
//
//   /api/freee/auth?secret=<CRON_SECRET>
//
// ブラウザからのリダイレクトなのでヘッダ認証が使えない。代わりに
// CRON_SECRET をクエリで要求し、CSRF 対策の state を Cookie に置く。

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { AUTHORIZE_URL, isFreeeConfigured, redirectUri } from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET が未設定です。環境変数に設定してください' },
      { status: 500 }
    );
  }
  if (req.nextUrl.searchParams.get('secret') !== secret) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  if (!isFreeeConfigured()) {
    return NextResponse.json(
      { error: 'freee の環境変数が未設定です(FREEE_CLIENT_ID など)' },
      { status: 500 }
    );
  }

  const state = randomBytes(16).toString('hex');
  const redirect = redirectUri(req.nextUrl.origin);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.FREEE_CLIENT_ID!);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);

  // 人事労務APIを使うにはスコープの明示が必要な場合がある。
  // freee アプリの設定画面に表示されているスコープを
  // FREEE_SCOPE にスペース区切りで入れると、ここで要求する
  if (process.env.FREEE_SCOPE) {
    url.searchParams.set('scope', process.env.FREEE_SCOPE);
  }

  const res = NextResponse.redirect(url.toString());
  // 認可から戻ってきた時に state を突き合わせる。第三者が自分の freee
  // アカウントで勝手に接続を上書きするのを防ぐ
  res.cookies.set('freee_oauth_state', state, {
    httpOnly: true,
    secure: req.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: '/api/freee',
    maxAge: 600,
  });
  return res;
}

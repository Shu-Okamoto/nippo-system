// freee の認可画面から戻ってくる先。
// 認可コードをトークンに交換して nippo.freee_tokens に保存する。
//
// freee アプリの「コールバックURL」にこの URL を登録すること:
//   https://<host>/api/freee/callback

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode, redirectUri, serviceClient } from '@/lib/freee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function page(title: string, body: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{font-family:system-ui,sans-serif;background:#f5f2ea;margin:0;padding:40px 20px}
 .box{max-width:520px;margin:0 auto;background:#fff;border:2px solid #1a1814;padding:24px}
 h1{font-size:18px;margin:0 0 12px}
 p{font-size:14px;line-height:1.7;margin:0 0 8px}
 .ng{color:#b3261e}
 a{color:#1a1814}
</style></head><body><div class="box">
<h1 class="${ok ? '' : 'ng'}">${title}</h1>${body}
</div></body></html>`,
    { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const error = sp.get('error');
  if (error) {
    return page(
      'freee との接続がキャンセルされました',
      `<p>${sp.get('error_description') || error}</p>`,
      false
    );
  }

  const code = sp.get('code');
  const state = sp.get('state');
  const expected = req.cookies.get('freee_oauth_state')?.value;

  if (!code) {
    return page('接続に失敗しました', '<p>認可コードが返ってきませんでした。</p>', false);
  }
  // state が一致しない = この画面から始めた接続ではない
  if (!expected || !state || state !== expected) {
    return page(
      '接続に失敗しました',
      '<p>セッションが確認できませんでした。管理画面からやり直してください。</p>',
      false
    );
  }

  try {
    const sb = serviceClient();
    await exchangeCode(sb, code, redirectUri(req.nextUrl.origin));
  } catch (e: any) {
    return page('接続に失敗しました', `<p>${e.message}</p>`, false);
  }

  const res = page(
    'freee と接続しました',
    `<p>管理画面の「勤怠管理」→ freee人事労務 連携 から打刻を送信できます。</p>
     <p>先にスタッフマスタで各メンバーの freee 従業員ID を設定してください。</p>
     <p><a href="/attendance">勤怠管理へ戻る</a></p>`,
    true
  );
  res.cookies.delete('freee_oauth_state');
  return res;
}

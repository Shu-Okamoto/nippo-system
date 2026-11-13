// freee人事労務 連携ユーティリティ(サーバ専用)
//
// このファイルはクライアントに渡らない前提。client secret と
// service role key を扱うので 'use client' を付けないこと。
//
// 必要な環境変数:
//   SUPABASE_SERVICE_ROLE_KEY      … freee_tokens を読み書きするため
//   FREEE_CLIENT_ID                … freeeアプリのClient ID
//   FREEE_CLIENT_SECRET            … freeeアプリのClient Secret
//   FREEE_COMPANY_ID               … 事業所ID
//   FREEE_INITIAL_REFRESH_TOKEN    … 初回のみ。DBに保存されたら不要
//
// 未設定なら isFreeeConfigured() が false を返し、同期は何もしない。

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const API_BASE = 'https://api.freee.co.jp';

// アクセストークンの有効期限がこの秒数以内なら先に更新する
const REFRESH_MARGIN_SEC = 300;

export type FreeeClockType = 'clock_in' | 'break_begin' | 'break_end' | 'clock_out';

export const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';

// freee アプリのコールバックURLがこの値だと、認可後にリダイレクトせず
// 画面に認可コードが表示される(手動で貼り付ける運用)
export const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

export function isFreeeConfigured(): boolean {
  return Boolean(
    process.env.FREEE_CLIENT_ID &&
      process.env.FREEE_CLIENT_SECRET &&
      process.env.FREEE_COMPANY_ID &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

/** freee アプリに登録したコールバックURL。未設定ならリクエストのオリジンから組み立てる */
export function redirectUri(origin: string): string {
  return process.env.FREEE_REDIRECT_URI || `${origin}/api/freee/callback`;
}

/**
 * 認可コードをアクセストークン/リフレッシュトークンに交換して保存する。
 * OAuth の初回接続でのみ使う。
 */
export async function exchangeCode(
  sb: SupabaseClient<any, any, any, any, any>,
  code: string,
  redirect: string
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.FREEE_CLIENT_ID!,
    client_secret: process.env.FREEE_CLIENT_SECRET!,
    code,
    redirect_uri: redirect,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `freee との接続に失敗しました (${res.status}): ${
        json.error_description || json.error || 'unknown'
      }`
    );
  }

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();
  const { error } = await sb.from('freee_tokens').upsert({
    id: 1,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: expiresAt,
    // 実際に許可されたスコープ。403 の切り分けに使う
    scope: json.scope ?? null,
  });
  if (error) {
    throw new Error(`freee トークンの保存に失敗しました: ${error.message}`);
  }
}

/** 実際に許可されているスコープ。未保存なら null */
export async function grantedScope(
  sb: SupabaseClient<any, any, any, any, any>
): Promise<string | null> {
  const { data } = await sb.from('freee_tokens').select('scope').eq('id', 1).maybeSingle();
  return (data as any)?.scope ?? null;
}

/** 接続済みか(トークンが保存されているか)を返す */
export async function isConnected(
  sb: SupabaseClient<any, any, any, any, any>
): Promise<boolean> {
  const { data } = await sb.from('freee_tokens').select('id').eq('id', 1).maybeSingle();
  return Boolean(data);
}

/**
 * 保存しているトークンの状態。値そのものは返さない。
 * 期限内のはずなのに 401 になる場合、ここが実態とずれていることがある。
 */
export async function tokenStatus(
  sb: SupabaseClient<any, any, any, any, any>
): Promise<{ expires_at: string | null; expires_in_hours: number | null } | null> {
  const { data } = await sb
    .from('freee_tokens')
    .select('expires_at')
    .eq('id', 1)
    .maybeSingle();
  const row = data as { expires_at: string } | null;
  if (!row) return null;
  return {
    expires_at: row.expires_at,
    expires_in_hours:
      Math.round(((new Date(row.expires_at).getTime() - Date.now()) / 3600000) * 10) / 10,
  };
}

/**
 * 人事労務APIに到達できるかを確認する。
 * ここが通らなければ、従業員一覧も打刻も通らない。
 * アプリに人事労務の権限が付いていない場合はここで 403 になる。
 */
export async function getHrMe(
  accessToken: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}/hr/api/v1/users/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * 人事労務ではない、共通の users/me を叩く。
 *
 * 人事労務APIが 401 のときの切り分け用。
 * ここが 200 なら「トークンは有効だが、認可したアカウントが人事労務に
 * アクセスできない」と確定する(人事労務側の権限・従業員登録の問題)。
 * ここも 401 ならトークン自体が無効。
 */
export async function getGeneralMe(
  accessToken: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}/api/1/users/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * 指定した事業所にこのトークンでアクセスできるかを確かめる。
 *
 * freee のアクセストークンは認可時に選んだ事業所に紐づく。
 * users/me に出てくる事業所でも、認可した事業所でなければ
 * invalid_authorization_company_id で弾かれる。
 * 全事業所を試すことで、実際に有効な事業所を特定できる。
 */
export async function probeCompany(
  accessToken: string,
  companyId: number
): Promise<{ ok: boolean; status: number; message?: string }> {
  const now = new Date();
  const params = new URLSearchParams({
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1),
    limit: '1',
  });
  const res = await fetch(
    `${API_BASE}/hr/api/v1/companies/${companyId}/employees?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  const body: any = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    message: res.ok ? undefined : body?.message || body?.code,
  };
}

/**
 * 勤怠情報(勤務実績)を1日分読む。
 *
 * 打刻(time_clocks)と同じ /employees/{id}/ 配下なので、
 * こちらも通らなければ従業員単位API全体が使えないと分かる。
 * 逆にこちらが通るなら、打刻ではなく勤務実績を書く方式に
 * 切り替えられる可能性がある。
 */
export async function getWorkRecord(
  accessToken: string,
  employeeId: string,
  date: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const path = encodeURIComponent(employeeId.trim());
  const params = new URLSearchParams({
    company_id: String(process.env.FREEE_COMPANY_ID),
  });
  const res = await fetch(
    `${API_BASE}/hr/api/v1/employees/${path}/work_records/${date}?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * 勤務実績を1日分まとめて書き込む。
 *
 * 打刻API(time_clocks)は当日の打刻を順に積む仕組みで過去日に使えない。
 * こちらは1日分の出退勤・休憩をまとめて設定でき、同じ日に何度実行しても
 * 同じ結果になる(PUT なので上書き)ため、過去分の同期に向く。
 *
 * break_records の clock_in_at / clock_out_at は
 * 「休憩開始 / 休憩終了」の意味。紛らわしいが freee の仕様。
 */
export async function putWorkRecord(
  accessToken: string,
  employeeId: string,
  date: string,
  clockIn: string,
  clockOut: string,
  breakMinutes: number,
  firstBreakBegin: string | null
): Promise<unknown> {
  const path = encodeURIComponent(employeeId.trim());
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const fmt = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  // 休憩は「丸めた合計と一致する1本」として送る。
  // 実際の休憩が47分でも丸めて60分にするため、実打刻の入り/戻りを
  // そのまま送ると freee 側の計算が画面の実働と食い違ってしまう。
  const breakRecords: { clock_in_at: string; clock_out_at: string }[] = [];
  if (breakMinutes > 0) {
    const startMin = toMin(clockIn);
    const endMin = toMin(clockOut);
    // 休憩の開始は実際の入り時刻に寄せる。無ければ勤務の中間に置く
    let bStart = firstBreakBegin ? toMin(firstBreakBegin) : startMin + Math.floor((endMin - startMin) / 2);
    // 勤務時間内に収める。はみ出すと freee 側で弾かれる
    bStart = Math.max(startMin, Math.min(bStart, endMin - breakMinutes));
    breakRecords.push({
      clock_in_at: `${date} ${fmt(bStart)}:00`,
      clock_out_at: `${date} ${fmt(bStart + breakMinutes)}:00`,
    });
  }

  const payload = {
    company_id: Number(process.env.FREEE_COMPANY_ID),
    break_records: breakRecords,
    clock_in_at: `${date} ${clockIn}:00`,
    clock_out_at: `${date} ${clockOut}:00`,
  };

  const res = await fetch(`${API_BASE}/hr/api/v1/employees/${path}/work_records/${date}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      json?.errors?.[0]?.messages?.[0] || json?.message || json?.error_description || '';
    throw new Error(
      `勤務実績の登録に失敗しました (${res.status})${detail ? `: ${detail}` : ''}\n` +
        `送信先: PUT /hr/api/v1/employees/${path}/work_records/${date}\n` +
        `送信内容: ${JSON.stringify(payload)}\n` +
        `freee応答: ${JSON.stringify(json).slice(0, 600)}`
    );
  }
  return json;
}

/** freee人事労務の従業員一覧。従業員IDをスタッフマスタに転記するために使う */
export async function listEmployees(accessToken: string): Promise<unknown> {
  const now = new Date();
  const params = new URLSearchParams({
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1),
    limit: '100',
  });
  const res = await fetch(
    `${API_BASE}/hr/api/v1/companies/${process.env.FREEE_COMPANY_ID}/employees?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      json?.errors?.[0]?.messages?.[0] || json?.message || JSON.stringify(json).slice(0, 300);
    throw new Error(`従業員一覧を取得できませんでした (${res.status}): ${detail}`);
  }
  return json;
}

export function serviceClient(): SupabaseClient<any, any, any, any, any> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL が未設定です');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'nippo' },
    global: {
      // Next.js は fetch の GET を Data Cache に載せる。Supabase の読み出しは
      // GET なので、何もしないとトークンの読み出しが古い値に固定される。
      //
      // しかも select の文字列ごとに別のキャッシュキーになるため、
      // 同じリクエスト内でも読んだ値が食い違う。実際にこれで
      // 使い捨てのリフレッシュトークンを使い回し、freee が発行済みの
      // 期限切れトークンを返す状態になっていた(2026-11-09〜)。
      //
      // トークンは「直前に書いた値」を必ず読めないといけないので、
      // この経路のリクエストはキャッシュさせない。
      fetch: (input: any, init?: any) => fetch(input, { ...(init ?? {}), cache: 'no-store' }),
    },
  });
}

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

/**
 * トークン更新で実際に何が起きたかの記録。切り分け用。
 * トークンの値そのものは持たせない。同一性の確認は指紋(sha256の先頭)で行う。
 */
export type RefreshInfo = {
  http_status: number;
  has_access_token: boolean;
  has_refresh_token: boolean;
  expires_in: number | null;
  token_type: string | null;
  scope: string | null;
  // freee が返すトークンの発行時刻(UNIX秒)。使い捨てのリフレッシュトークンを
  // 使い回すと、freee は発行済み(＝期限切れ)のトークンを返す。
  // ここが古ければそれが起きている
  created_at: number | null;
  created_at_iso: string | null;
  response_keys: string[];
  new_token_fp: string | null;
  stored_token_fp_before: string | null;
  token_changed: boolean | null;
  expires_at_written: string | null;
  saved: boolean;
  save_error: string | null;
};

/** トークンの同一性だけを見るための指紋。値は復元できない */
export function tokenFingerprint(token: string | null | undefined): string | null {
  if (!token) return null;
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

async function refreshToken(
  sb: SupabaseClient<any, any, any, any, any>,
  refresh: string,
  storedAccessToken?: string | null
): Promise<{ accessToken: string; info: RefreshInfo }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.FREEE_CLIENT_ID!,
    client_secret: process.env.FREEE_CLIENT_SECRET!,
    refresh_token: refresh,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `freee トークン更新に失敗しました (${res.status}): ${
        json.error_description || json.error || 'unknown'
      }`
    );
  }

  // 200 でも access_token が入っていないことがあり得る。
  // そのまま保存すると「更新成功」と見えて古いトークンを使い続けるので弾く
  if (!json.access_token) {
    throw new Error(
      `freee トークン更新の応答に access_token がありません (${res.status}): ` +
        `応答の項目=${Object.keys(json).join(',') || '(なし)'}`
    );
  }

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();

  const info: RefreshInfo = {
    http_status: res.status,
    has_access_token: Boolean(json.access_token),
    has_refresh_token: Boolean(json.refresh_token),
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : null,
    token_type: json.token_type ?? null,
    scope: json.scope ?? null,
    created_at: typeof json.created_at === 'number' ? json.created_at : null,
    created_at_iso:
      typeof json.created_at === 'number' ? new Date(json.created_at * 1000).toISOString() : null,
    response_keys: Object.keys(json),
    new_token_fp: tokenFingerprint(json.access_token),
    stored_token_fp_before: tokenFingerprint(storedAccessToken),
    token_changed: storedAccessToken ? json.access_token !== storedAccessToken : null,
    expires_at_written: expiresAt,
    saved: false,
    save_error: null,
  };

  // freee はリフレッシュトークンを毎回ローテーションするため必ず保存する。
  // ここで保存に失敗すると次回以降認証できなくなるのでエラーを伝播させる。
  const { error } = await sb.from('freee_tokens').upsert({
    id: 1,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: expiresAt,
    scope: json.scope ?? null,
  });
  if (error) {
    info.save_error = error.message;
    throw new Error(`freee トークンの保存に失敗しました: ${error.message}`);
  }
  info.saved = true;

  return { accessToken: json.access_token as string, info };
}

/**
 * 連携状態を記録する。失敗していれば勤怠管理に警告を出すために使う。
 *
 * 記録自体が失敗しても本処理は止めない。ここで例外を投げると
 * 送信そのものが落ちてしまい、本末転倒になる。
 */
export async function recordHealth(
  sb: SupabaseClient<any, any, any, any, any>,
  ok: boolean,
  context: string,
  code?: string | null,
  message?: string | null
): Promise<void> {
  try {
    await sb.rpc('set_freee_health', {
      p_ok: ok,
      p_code: code ?? null,
      p_message: message ?? null,
      p_context: context,
    });
  } catch {
    // 記録できなくても送信は続ける
  }
}

// 更新リースの保持時間と、負けた側が待つ上限
const REFRESH_LOCK_SEC = 30;
const REFRESH_WAIT_MS = 15000;
const REFRESH_POLL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 有効なアクセストークンと、その入手経路を返す。
 *
 * 「更新したのに古いトークンを送っていた」のような食い違いを
 * 追えるようにするため、更新の実態(RefreshInfo)も一緒に返す。
 *
 * 更新は必ずリースを取ってから行う。リフレッシュトークンは使い捨てで、
 * 同時に2つ更新すると片方が取得した有効なトークンが捨てられ、以後
 * どう更新しても通らなくなる。リースを取れなかった側は更新せず、
 * 勝った側が書いた新しいトークンを待って使う。
 */
export async function getAccessTokenDetailed(
  sb: SupabaseClient<any, any, any, any, any>,
  force = false
): Promise<{
  accessToken: string;
  source: 'stored' | 'refreshed' | 'seeded' | 'waited';
  sent_token_fp: string | null;
  stored_expires_at: string | null;
  refresh: RefreshInfo | null;
}> {
  const readRow = async (): Promise<TokenRow | null> => {
    const { data, error } = await sb
      .from('freee_tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`freee トークンの読み込みに失敗しました: ${error.message}`);
    return data as TokenRow | null;
  };

  const row = await readRow();

  if (!row) {
    const seed = process.env.FREEE_INITIAL_REFRESH_TOKEN;
    if (!seed) {
      throw new Error(
        'freee トークンが未登録です。FREEE_INITIAL_REFRESH_TOKEN を設定して一度同期を実行してください'
      );
    }
    const r = await refreshToken(sb, seed);
    return {
      accessToken: r.accessToken,
      source: 'seeded',
      sent_token_fp: tokenFingerprint(r.accessToken),
      stored_expires_at: null,
      refresh: r.info,
    };
  }

  const expiresInSec = (new Date(row.expires_at).getTime() - Date.now()) / 1000;
  if (!force && expiresInSec > REFRESH_MARGIN_SEC) {
    return {
      accessToken: row.access_token,
      source: 'stored',
      sent_token_fp: tokenFingerprint(row.access_token),
      stored_expires_at: row.expires_at,
      refresh: null,
    };
  }

  // 更新する権利を取りに行く
  const { data: got, error: lockError } = await sb.rpc('freee_refresh_lock', {
    p_seconds: REFRESH_LOCK_SEC,
  });

  // 36_freee_lock_and_health.sql 未実行なら関数が無い。
  // その場合は従来どおり直接更新する(直列化なし)
  const lockAvailable = !lockError || (lockError as any).code !== 'PGRST202';

  if (lockAvailable && got !== true) {
    // 負けた側。勝った側が新しいトークンを書くのを待つ
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(REFRESH_POLL_MS);
      const fresh = await readRow();
      if (fresh && fresh.access_token !== row.access_token) {
        return {
          accessToken: fresh.access_token,
          source: 'waited',
          sent_token_fp: tokenFingerprint(fresh.access_token),
          stored_expires_at: fresh.expires_at,
          refresh: null,
        };
      }
    }
    throw new Error(
      '別の処理が freee トークンを更新中です。少し待ってからもう一度実行してください'
    );
  }

  try {
    // リースを取ってから改めて読む。待っている間に
    // 他が更新を終えていれば、それを使って更新を1回で済ませる
    const latest = (await readRow()) ?? row;
    const latestSec = (new Date(latest.expires_at).getTime() - Date.now()) / 1000;
    if (!force && latestSec > REFRESH_MARGIN_SEC) {
      return {
        accessToken: latest.access_token,
        source: 'stored',
        sent_token_fp: tokenFingerprint(latest.access_token),
        stored_expires_at: latest.expires_at,
        refresh: null,
      };
    }

    const r = await refreshToken(sb, latest.refresh_token, latest.access_token);
    return {
      accessToken: r.accessToken,
      source: 'refreshed',
      sent_token_fp: tokenFingerprint(r.accessToken),
      stored_expires_at: latest.expires_at,
      refresh: r.info,
    };
  } finally {
    if (lockAvailable) {
      // 解放に失敗しても期限で空くので、ここでは落とさない
      try {
        await sb.rpc('freee_refresh_unlock');
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * 有効なアクセストークンを返す。期限が近ければ更新して保存する。
 * DBに未登録なら FREEE_INITIAL_REFRESH_TOKEN で初期化する。
 *
 * force=true なら期限に関係なく更新する。保存済みトークンが期限内でも
 * freee 側で無効になっている(認可し直し等)ことがあり、401 を受けた
 * あとの取り直しに使う。
 */
export async function getAccessToken(
  sb: SupabaseClient<any, any, any, any, any>,
  force = false
): Promise<string> {
  const r = await getAccessTokenDetailed(sb, force);
  return r.accessToken;
}

/**
 * freee の応答が「このアクセストークンでは認証できない」かどうか。
 * 期限内のはずのトークンが無効になっている場合に、取り直して
 * 1度だけやり直す判定に使う。
 */
export function isUnauthorizedError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return msg.includes('invalid_access_token') || msg.includes('(401)');
}

/**
 * 打刻を1件 freee に送る。成功なら freee 側のIDらしき値を返す。
 * 失敗時は例外を投げる(呼び出し側でイベントに error を記録する)。
 */
export async function postTimeClock(
  accessToken: string,
  employeeId: string,
  type: FreeeClockType,
  baseDate: string,
  datetime: string
): Promise<unknown> {
  // ゼロ埋めを落とさないよう数値化せずそのまま渡す
  const path = encodeURIComponent(employeeId.trim());
  const payload = {
    company_id: Number(process.env.FREEE_COMPANY_ID),
    type,
    base_date: baseDate,
    datetime,
  };
  const res = await fetch(`${API_BASE}/hr/api/v1/employees/${path}/time_clocks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // freee の 400 は文言が汎用的で原因が分からないため、送信内容と
    // 生レスポンスを両方残す。ここをケチると切り分けができない
    const detail =
      json?.errors?.[0]?.messages?.[0] ||
      json?.message ||
      json?.error_description ||
      '';
    throw new Error(
      `freee 打刻登録に失敗しました (${res.status})${detail ? `: ${detail}` : ''}\n` +
        `送信先: /hr/api/v1/employees/${path}/time_clocks\n` +
        `送信内容: ${JSON.stringify(payload)}\n` +
        `freee応答: ${JSON.stringify(json).slice(0, 600)}`
    );
  }
  return json;
}

/**
 * その従業員が今どの打刻を打てるかを freee に問い合わせる。
 * 従業員ID・事業所ID・スコープがまとめて検証できるので切り分けに使う。
 */
export async function getAvailableTypes(
  accessToken: string,
  employeeId: string,
  date: string
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const path = encodeURIComponent(employeeId.trim());
  const params = new URLSearchParams({
    company_id: String(process.env.FREEE_COMPANY_ID),
    date,
  });
  const res = await fetch(
    `${API_BASE}/hr/api/v1/employees/${path}/time_clocks/available_types?${params}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** UTCのISO文字列を freee が要求する JST の "YYYY-MM-DD HH:MM:SS" に変換する */
export function toJstDateTime(iso: string): { baseDate: string; datetime: string } {
  const d = new Date(iso);
  // JST(UTC+9)に寄せてから UTC 系のゲッタで読むと JST の壁時計になる
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}`;
  const time = `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}:${p(jst.getUTCSeconds())}`;
  return { baseDate: date, datetime: `${date} ${time}` };
}

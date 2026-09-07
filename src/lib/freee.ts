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
  });
}

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

async function refreshToken(sb: SupabaseClient<any, any, any, any, any>, refresh: string) {
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

  const expiresAt = new Date(Date.now() + (json.expires_in ?? 21600) * 1000).toISOString();

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
    throw new Error(`freee トークンの保存に失敗しました: ${error.message}`);
  }

  return json.access_token as string;
}

/**
 * 有効なアクセストークンを返す。期限が近ければ更新して保存する。
 * DBに未登録なら FREEE_INITIAL_REFRESH_TOKEN で初期化する。
 */
export async function getAccessToken(
  sb: SupabaseClient<any, any, any, any, any>
): Promise<string> {
  const { data, error } = await sb
    .from('freee_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(`freee トークンの読み込みに失敗しました: ${error.message}`);

  const row = data as TokenRow | null;

  if (!row) {
    const seed = process.env.FREEE_INITIAL_REFRESH_TOKEN;
    if (!seed) {
      throw new Error(
        'freee トークンが未登録です。FREEE_INITIAL_REFRESH_TOKEN を設定して一度同期を実行してください'
      );
    }
    return refreshToken(sb, seed);
  }

  const expiresInSec = (new Date(row.expires_at).getTime() - Date.now()) / 1000;
  if (expiresInSec > REFRESH_MARGIN_SEC) {
    return row.access_token;
  }
  return refreshToken(sb, row.refresh_token);
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

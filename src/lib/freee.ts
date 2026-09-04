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
  });
  if (error) {
    throw new Error(`freee トークンの保存に失敗しました: ${error.message}`);
  }
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

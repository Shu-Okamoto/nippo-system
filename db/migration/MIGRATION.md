# DB 移行手順 — 現行 Supabase → DXシステム側 Supabase (`nippo` スキーマ)

すべて Supabase Dashboard の **SQL Editor** だけで完結します。
3ステップで終わります。

---

## 移行先プロジェクト情報

- URL: `https://useoasbqbccgaznyhnma.supabase.co`
- anon キー: Dashboard → Project Settings → API から取得し、ローカル `.env.local` に貼る

---

## Step 1 — 移行先で nippo スキーマと全テーブルを作成

移行先 Dashboard → **SQL Editor** で `01_setup_target.sql` を **そのまま** 実行。

これで以下まで揃います:

- `nippo` スキーマ + 権限
- 全 6 テーブル(`stores`, `staff`, `products`, `daily_reports`, `shift_entries`, `order_lines`)
- インデックス / FK / CHECK 制約 / UNIQUE
- `updated_at` 自動更新トリガ(全テーブル)

実行後、Dashboard → **Project Settings → API → Exposed schemas** に `nippo` を追加。

---

## Step 2 — View と RPC を移行先に作成

**移行元** SQL Editor で `02_dump_runtime.sql` を実行。

結果は **5 行・1 列**(`ddl_text`)のテーブルで返ります:

| 行 | 中身 |
|---|---|
| 1 | `CREATE OR REPLACE VIEW nippo.daily_kpi …` |
| 2 | `CREATE FUNCTION nippo.add_product(…) …` |
| 3 | `CREATE FUNCTION nippo.get_orders_for_pdf(…) …` |
| 4 | `CREATE FUNCTION nippo.get_today_full(…) …` |
| 5 | `CREATE FUNCTION nippo.save_daily_report_full(…) …` |

**各行の `ddl_text` セルをクリック** → 全文表示 → コピー → **移行先** SQL Editor に貼って実行。
これを 5 回繰り返す(順番は問わない)。

---

## Step 3 — データを移行

**移行元** SQL Editor で `03_dump_data.sql` を 1 セクションずつ実行。
各セクションの結果(`ins_sql` 列)をコピーして **移行先** SQL Editor に順番に貼って実行。

実行順序は必ず:

```
stores → staff → products → daily_reports → shift_entries → order_lines
```

最後に **セクション 7(setval)** の出力も実行して、id 採番を移行データに合わせる。

安全のため、全 INSERT を `BEGIN; ... COMMIT;` で囲んで一括実行を推奨。

---

## Step 4 — アプリ動作確認

ローカル `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://useoasbqbccgaznyhnma.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<DX側 anon キー>
```

`npm run dev` で起動し、`/admin`, `/store/iwakuni/today`, `/dashboard` が移行前と同じに見えれば完了。

---

## トラブルシュート

### `relation "nippo" does not exist` で 400 が返る

Supabase SQL Editor が本文中の `CREATE TABLE` / `INSERT INTO` 等の文字列を
DDL/書込み操作と誤検出して、存在しないスキーマの事前バリデーションで落ちる挙動です。
本リポジトリの SQL はキーワードを `'CRE' || 'ATE TABLE …'` のように分割して
回避しています。ご自身でクエリをカスタマイズする場合は同じ要領で。

---

## Step 5(オプション)— dx.sale 連携 RPC

スタッフ画面 `/store/<slug>/today` の「売上予測(前年)」「売上実績」を
`dx.sale` テーブルから取得する場合、`04_dx_sales_rpc.sql` を移行先 SQL
Editor で1回実行する。

- `nippo.get_dx_sales(store_slug, today)` を SECURITY DEFINER で作成
- `dx.sale.storeId` の slug マッピングは関数内ハードコード(`nishi=1, minami=2`)
- 「前年同日付前後で一番近い同曜日」の売上を `forecast` として返す
- 当日の売上を `actual` として返す
- 該当データなしは `null`(画面側で `—` 表示)

dx スキーマを Exposed schemas に追加する必要はありません(SECURITY DEFINER 経由)。

### 切り戻し

`.env.local` の URL/anon キーを現行プロジェクトに戻すだけ。
移行先は `DROP SCHEMA nippo CASCADE;` で初期化可能。

---

## Step 6 — 過去日報の編集を可能にする RPC(管理画面 `/edit/[slug]/[date]` 用)

`09_edit_past_reports.sql` を移行先 SQL Editor で1回実行する。

以下2つの RPC が追加される:

- `nippo.get_report_full(p_slug text, p_date date)` … 任意日付の日報 +
  シフト + 注文を jsonb 一括で返す(`get_today_full` の日付パラメータ版)
- `nippo.save_report_full(p_slug, p_date, ...)` … 任意日付の日報を
  一括保存(`save_daily_report_full` と違い dx.sale の再フェッチをせず、
  フロントから渡された値をそのまま保存)

既存の `get_today_full` / `save_daily_report_full` はそのまま残しており、
スタッフ画面 `/store/<slug>/today` の動作には影響しない。

---

## Step 7 — 勤怠打刻(タイムクロック)

`11_time_clock.sql` を移行先 SQL Editor で1回実行する。

追加されるもの:

| 種別 | 名前 | 用途 |
|---|---|---|
| テーブル | `nippo.time_clock_events` | 打刻イベントの追記専用ログ |
| テーブル | `nippo.freee_tokens` | freee OAuth トークン(**RLS 有効・anon 遮断**) |
| 列 | `nippo.staff.freee_employee_id` | freee人事労務の従業員ID |
| 関数 | `punch(slug, staff_id, event_type)` | 打刻を記録し実績シフトに反映 |
| 関数 | `get_clock_board(slug)` | 打刻画面用の当日状態 |
| 関数 | `void_punch(event_id)` | 誤打刻の取消(管理画面から) |
| 関数 | `rebuild_actual_shift(...)` | イベントログから実績シフトを再構築 |

### 設計メモ

- 打刻は `shift_entries`(`entry_type='actual'`)に自動反映される。
  既存のダッシュボード・月間レポートは変更なしで実績を拾う。
- イベントログが唯一の真実で、`shift_entries` はその射影。
  取消すると実績シフトも組み立て直される。
- 勤務日は **日本時間(Asia/Tokyo)の当日固定**。営業が 9-17 時で
  日跨ぎしないため、未退勤セッションを翌日に引き継ぐ処理はしない。
- 休憩が2回以上ある日は `break_start` / `break_end` を空にし、合計を
  `break_minutes` に入れる。アプリの `shiftMinutes()` は両方揃っていると
  そちらを優先して1回分しか引かないため。

### 打刻画面

`/store/<slug>/clock`(認証なし・店舗の共有端末を想定)。
トップページからもリンクしている。

---

## Step 8(オプション)— freee人事労務 連携

打刻を freee人事労務 に送信する場合のみ設定する。**未設定でも打刻機能は動く**。

### 1. freee アプリを作成

freee アプリストアで開発者向けアプリを作成し、Client ID / Client Secret を取得。
必要スコープ: **人事労務(hr)の打刻登録**。

### 2. リフレッシュトークンを取得

OAuth 認可フローを一度手動で通し、`refresh_token` を取得する。

### 3. Vercel の環境変数に設定

```
SUPABASE_SERVICE_ROLE_KEY=<Supabase の service_role キー>
FREEE_CLIENT_ID=<Client ID>
FREEE_CLIENT_SECRET=<Client Secret>
FREEE_COMPANY_ID=<事業所ID>
FREEE_INITIAL_REFRESH_TOKEN=<手順2で取得した refresh_token>
CRON_SECRET=<任意の文字列>   # 定期実行する場合のみ
```

いずれも **`NEXT_PUBLIC_` を付けない**こと(付けるとブラウザに露出する)。

`FREEE_INITIAL_REFRESH_TOKEN` は初期化用の種。freee はリフレッシュトークンを
毎回ローテーションするため、一度同期に成功したら以降は `nippo.freee_tokens`
に保存された値が使われる。

### 4. スタッフに freee 従業員ID を設定

管理画面 → スタッフマスタ → 「freee従業員ID」列に入力。
**未設定のスタッフの打刻は送信されず `対象外` になる**。

### 5. 送信する

管理画面 → 勤怠打刻タブ → 「freee に送信」ボタン。

定期実行したい場合は `vercel.json` に Cron を追加し、
`POST /api/freee/sync` をヘッダ `x-cron-secret: <CRON_SECRET>` 付きで叩く。

### 認証について

`/api/freee/sync` は人事データを外部送信するため、
`x-cron-secret` ヘッダか Supabase のログイン済みアクセストークンが必要。
無認証では 401 を返す。

---

## Step 9 — 打刻の管理(追加・編集・削除)

`12_punch_admin.sql` を移行先 SQL Editor で1回実行する(`11_time_clock.sql` 実行済みが前提)。

打刻もれ・打ち間違いを本部側で直すための関数を追加する。

| 関数 | 用途 |
|---|---|
| `add_punch(slug, staff_id, work_date, event_type, time, note)` | 打刻もれを後から追加 |
| `update_punch(event_id, event_type, time, note)` | 時刻・種別を修正 |
| `delete_punch(event_id)` | 削除(取消フラグ) |
| `restore_punch(event_id)` | 削除の取り消し |
| `jst_timestamp(date, "HH:MM")` | JST の日付+時刻から timestamptz を作る補助 |

あわせて `freee_status` に `manual`(要手動修正)を追加し、
`edited_at` 列で手修正済みを判別できるようにする。

### 設計メモ

- **削除は物理削除ではなく取消フラグ。** 労務記録として履歴を残す必要が
  あるため。画面では既定で非表示になるので、操作感は削除と同じ。
  「削除済も表示」にチェックを入れると復元できる。
- 追加・編集・削除のいずれも実行後に `rebuild_actual_shift()` が走り、
  実績シフト(`shift_entries`)が組み立て直される。
- **freee 送信済みの打刻を直しても freee 側は自動で変わらない。**
  そのため送信済みを修正・削除すると `freee_status = 'manual'`
  (要手動修正)になり、管理画面で赤バッジとして目立つ。
  `manual` は再送対象にならない(再送すると freee 側で二重になるため)。
- 追加・編集では打刻の順序を検証しない。壊れた並びを直すのが管理画面の
  役目なので、厳密な状態遷移チェックはかけていない。

### 画面

管理画面 → **勤怠打刻** タブ。

- 上部に「この日の実績(打刻から自動計算)」を表示。修正した結果が
  出勤・退勤・休憩・実働にどう効いたかをその場で確認できる
- 退勤が抜けている人は実績表の「退勤」列に赤字で **未** と出る
- 各行の **編集**(時刻・種別)/ **削除** / **復元**
- 下部のフォームから **打刻を追加**(停止中のスタッフも選べる)

---

## Step 10 — 勤怠打刻と日報実績の分離【方針変更】

`13_decouple_punch_from_shift.sql` を移行先 SQL Editor で1回実行する
(`11` `12` 実行済みが前提)。

### 方針

当初は打刻を日報の実績シフトに自動反映していたが、運用方針を変更した。

| | 入力者 | 目的 | 保存先 |
|---|---|---|---|
| **日報の実績入力** | 店長 | 経営者目線での実績把握 | `shift_entries` |
| **勤怠打刻** | 各メンバー | 労務記録・給与計算 | `time_clock_events` |

**この2つは互いに影響しない。** 打刻しても日報の実績は変わらないし、
日報の実績を直しても打刻は変わらない。店長はこれまで通り日報に実績を
入力する。

### 変更内容

- `rebuild_actual_shift()` を**廃止**。打刻系の関数は `shift_entries` に
  一切触れなくなる
- `punch()` は日報(`daily_reports`)の器も作らなくなる
  (打刻しただけで空の日報ができてしまうため)
- 打刻の集計は `shift_entries` を経由せず、イベントログから直接計算する
  `clock_summary(staff_id, work_date)` を新設
- `get_clock_board()` を `shift_entries` 非依存に作り直し
- 管理画面のサマリー用に `get_attendance_summary(slug, date)` を新設

### 検証で作られた実績行の掃除

`11` の検証中に打刻した分は `shift_entries`(actual)に書き込まれている。
分離した以上その行は日報側の入力ではないので消したいが、店長が手入力した
実績と混ざっている可能性があるため**自動では消さない**。

`13_decouple_punch_from_shift.sql` の末尾にコメントアウトした
確認用 SELECT と DELETE を用意してある。中身を確認したうえで、
必要なら DELETE のコメントを外して実行すること。

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

---

## Step 11 — 勤怠のメンバー別 月間ビュー

`14_attendance_month.sql` を移行先 SQL Editor で1回実行する
(`13_decouple_punch_from_shift.sql` 実行済みが前提)。

`get_attendance_month(slug, staff_id, from, to)` を追加する。
1人のメンバーの指定期間を日別に返し、あわせて合計実働時間と出勤日数を返す。

打刻が無い日も行として返す。**打刻もれの発見と、その日への打刻補完**を
同じ画面で完結させるため。

### 画面

勤怠管理(`/attendance`)に **日別(店舗)** / **月別(メンバー)** の切替を追加。

- 月別は店舗 → 月 → メンバーを選ぶと、その人の1か月が日別に並ぶ
- 上部に メンバー / 出勤日数 / 合計実働 のサマリー
- 退勤が無い日、打刻数が奇数の日は「打刻もれ」バッジが付く
- **行をクリックするとその日の日別ビューに移り、そのメンバーで絞り込まれる**。
  そのまま打刻の編集・追加・削除ができ、「月別に戻る」で元の月に戻れる

---

## Step 12 — 打刻のPIN認証 + 時給の管理

`16_staff_pin.sql` を移行先 SQL Editor で1回実行する
(`15_punch_list_rpc.sql` まで実行済みが前提)。

### 方針

共有端末はそのままに、**メンバーを選んだあと本人のPINを入力しないと
打刻できない**ようにする。個人アカウント(メール+パスワード)にすると
毎回ログイン・ログアウトが必要になり、打刻もれが増えて逆効果のため。

### PINハッシュと時給を staff テーブルに置かない理由

アプリは `staff` を `select('*')` で読んでおり、Phase 1 は anon アクセス
前提。`staff` に置くと **PINハッシュと時給がブラウザに配られてしまう**。
4〜6桁のPINはハッシュが漏れるとオフラインで総当たりされるため、
`nippo.staff_private` に隔離して RLS を有効化し、
`SECURITY DEFINER` の RPC 経由でしか触れないようにしている。

| 関数 | 用途 | 呼べる人 |
|---|---|---|
| `set_staff_pin(staff_id, pin)` | PIN発行・再発行・解除 | ログイン済みのみ |
| `set_staff_wage(staff_id, wage)` | 時給の設定 | ログイン済みのみ |
| `get_staff_private()` | PIN有無・ロック状態・時給の一覧 | ログイン済みのみ |
| `punch_with_pin(slug, staff_id, type, pin)` | PIN認証つき打刻 | 誰でも(打刻端末) |

管理系は `nippo.is_admin()`(JWTのroleが `authenticated` か)で判定する。
**PINハッシュはどの RPC からも返さない。** 設定済みかどうかだけを返す。

### 総当たり対策

PINを5回連続で間違えると10分ロックする。ロック中は打刻画面に
残り時間が表示される。成功すると失敗回数はリセットされる。

### PIN無し打刻の遮断

旧 `punch()` は `punch_with_pin()` からの内部呼び出し専用にし、
PostgREST からは実行できないよう `REVOKE` している。
**16 を実行した時点で、PIN未設定のメンバーは打刻できなくなる。**
先に管理画面でPINを発行しておくこと。

### 運用手順

1. 管理画面 → スタッフマスタ → 各メンバーの「打刻PIN」列で **発行**
2. 4〜6桁の数字を入力(本人に口頭で伝える)
3. 打刻画面で 名前をタップ → PIN入力 → 打刻種別を押す

PINを忘れた場合は同じ列の **再発行**、退職時は **解除** で打刻できなくなる。
時給は同じ行の「時給」列に入力するとフォーカスを外した時点で保存される。

---

## Step 13 — 打刻PINの ON/OFF 切替

`17_punch_pin_toggle.sql` を移行先 SQL Editor で1回実行する
(`16_staff_pin.sql` 実行済みが前提)。

運用に合わせて **打刻時のPIN入力を全体一律で ON/OFF** できるようにする。
メンバー個別ではなく全員まとめての設定。

| 関数 | 用途 | 呼べる人 |
|---|---|---|
| `get_app_settings()` | 現在の設定を取得 | 誰でも |
| `set_require_punch_pin(bool)` | PIN要否の切替 | ログイン済みのみ |

`punch_with_pin()` は設定が OFF のとき PIN 検証をとばす。
`get_clock_board()` は `require_pin` を返すので、打刻画面はテンキーを
出すかどうかを自動で切り替える。

### 挙動

| 設定 | 打刻画面 | PIN未設定のメンバー |
|---|---|---|
| **必要**(既定) | 名前 → PIN入力 → 打刻種別 | 打刻できない |
| **不要** | 名前 → 打刻種別 | 打刻できる |

OFF にしても **PIN の設定内容は消えない**。いつでも ON に戻せる。

### 画面

管理画面 → スタッフマスタ の上部に「打刻時のPIN入力 [必要|不要]」を配置。
切り替え時は影響を説明する確認ダイアログを出す。

---

## Step 14 — 個人専用の打刻URL(LINE配信用)

`18_personal_clock_link.sql` を移行先 SQL Editor で1回実行する
(`17_punch_pin_toggle.sql` 実行済みが前提)。

DX 側の LINE メッセージングから、メンバーごとに違う URL を配って
**その人の打刻画面だけ**を開けるようにする。

```
https://<host>/clock/<token>
```

| 関数 | 用途 | 呼べる人 |
|---|---|---|
| `issue_clock_token(staff_id, force)` | URL発行・再発行 | ログイン済みのみ |
| `revoke_clock_token(staff_id)` | URL失効 | ログイン済みのみ |
| `get_personal_clock(token)` | 本人の当日状態を取得 | 誰でも |
| `punch_by_token(token, type, pin)` | トークン経由の打刻 | 誰でも |

トークンは 48 文字の16進乱数。`staff_private` に置いているので
公開テーブル(`staff`)からは漏れない。

### セキュリティ

**URL だけでは本人確認にならない。** LINE のトーク履歴に残るし、
転送もスクリーンショットもできる。そのため:

- PIN 設定が「必要」のときは、個人URLでも PIN を求める。
  URL は「誰の画面か」を決めるだけで、本人確認は PIN が担う
- `punch_by_token()` は `staff_id` を受け取らない。トークンから
  本人を引くので、他人になりすまして打刻できない
- 個人打刻ページは `robots: noindex` で検索エンジンに載せない
- 退職時は「失効」でその場で使えなくなる

PIN 設定が「不要」のときは URL を知っていれば打刻できる。
手軽さを優先する場合の運用と割り切ること。

### DX 側との連携手順

1. 管理画面 → スタッフマスタ → 「個人打刻URL」列で **URL発行**
   (発行するとクリップボードにコピーされる)
2. DX 側でメンバーと URL を紐付けて保存
3. LINE のフックポイントでユーザーを識別し、対応する URL を送信

トークンは再発行するまで変わらないので、DX 側は一度保存すればよい。
URL が漏れた場合は **再発行** で古い URL が即座に無効になる。

---

## Step 8 補足 — freee との接続手順(OAuth を画面から実行)

`/api/freee/auth` を用意したので、リフレッシュトークンを手作業で
取得する必要はなくなった。

### 1. freee アプリを作成

freee アプリストアの開発者ページでアプリを作成する。

- **コールバックURL** に次を登録する
  ```
  https://<本番ホスト>/api/freee/callback
  ```
- 権限(スコープ)は **人事労務 の打刻登録・従業員参照** を有効にする
- Client ID / Client Secret を控える

### 2. Vercel に環境変数を設定

```
SUPABASE_SERVICE_ROLE_KEY=<Supabase の service_role キー>
FREEE_CLIENT_ID=<Client ID>
FREEE_CLIENT_SECRET=<Client Secret>
FREEE_COMPANY_ID=<事業所ID>
CRON_SECRET=<長いランダム文字列>
FREEE_REDIRECT_URI=https://<本番ホスト>/api/freee/callback
```

いずれも `NEXT_PUBLIC_` を付けないこと。設定後に再デプロイする。

### 3. freee と接続する

ブラウザで次を開く。

```
https://<本番ホスト>/api/freee/auth?secret=<CRON_SECRET>
```

freee の認可画面が出るので許可すると、トークンが `nippo.freee_tokens`
に保存されて「接続しました」と表示される。

以降トークンは自動で更新される(freee はリフレッシュトークンを毎回
ローテーションするため、更新後の値を都度保存している)。

### 4. 従業員IDを紐付ける

1. 管理画面 → 勤怠管理 → **freee の従業員IDを確認** を押す
2. 表示された ID を、スタッフマスタの「freee従業員ID」列に入力

**未設定のメンバーの打刻は送信されず `対象外` になる。**

### 5. 送信する

管理画面 → 勤怠管理 → **freee に送信**。

定期実行したい場合は `vercel.json` に Cron を追加し、
`POST /api/freee/sync` をヘッダ `x-cron-secret: <CRON_SECRET>` で叩く。

### つまずいたら

- **接続に失敗しました(セッションが確認できませんでした)**
  → `/api/freee/auth` から始めていない。必ず auth から開く
- **redirect_uri のエラー**
  → freee アプリに登録したコールバックURLと `FREEE_REDIRECT_URI` が
    完全一致していない(末尾スラッシュ・http/https も含めて)
- **従業員一覧が空**
  → スコープ不足か事業所IDの誤り。`FREEE_COMPANY_ID` を確認する

---

## Step 15 — freee従業員ID を文字列に変更

`19_freee_employee_id_text.sql` を移行先 SQL Editor で1回実行する。

`nippo.staff.freee_employee_id` を `integer` → `text` に変更する。
freee の画面に出る従業員番号は `000015` のようにゼロ埋めされており、
integer では先頭のゼロが落ちて入力どおりに保存できないため。

送信時は数値化せず、そのまま API のパスに渡す。

### API ID と 従業員番号 の違い

freee人事労務には似た値が2つある。**打刻APIが使うのは API ID の方**。

| 呼び名 | 例 | 用途 |
|---|---|---|
| **API ID**(`id`) | `15` | `/employees/{id}/time_clocks` のパス |
| 従業員番号(`num`) | `000015` | freee の画面表示・給与明細など |

管理画面 → 勤怠管理 → **freee の従業員IDを確認** で両方を並べて表示する。
スタッフマスタには **API ID** を入力すること。

従業員番号を入れると打刻送信時に 404 系のエラーになる。その場合は
勤怠管理の打刻一覧で `エラー` バッジにカーソルを合わせると原因が出る。

---

## Step 16 — RLS を有効化する

`20_enable_rls.sql` を移行先 SQL Editor で1回実行する。

Supabase の警告 `Table nippo.stores is public, but RLS has not been enabled.`
への対応。

### なぜ今やるか

Phase 1 は「未認証アクセス前提」で RLS を切っていた。その後、
勤怠打刻(労務記録)・売上・時給・PIN を持つようになり、
**anon キー(ブラウザに配られる公開値)で何でも読み書きできる状態**は
放置できなくなった。

### 2段階に分ける

一律に閉じると店舗画面(未認証)が動かなくなるため、実際のアクセス
経路を調べて分けている。

| Tier | テーブル | anon | authenticated |
|---|---|---|---|
| **1 完全遮断** | `time_clock_events` `staff_private` `freee_tokens` `app_settings` | × | × |
| **2 読み取りのみ** | `stores` `staff` `products` `report_questions` `daily_reports` `shift_entries` `order_lines` `report_answers` | SELECT のみ | 全操作 |

**Tier 1 はポリシーを1つも作らない。** クライアントはこれらを直接
触っておらず、すべて `SECURITY DEFINER` の RPC 経由なので閉じても
壊れない(直接読んでいるのはサーバ側 API ルートの service role のみ)。

**Tier 2 は SELECT だけ anon に許可する。** 店舗の日報画面・打刻画面・
公開ダッシュボードが未認証でこれらを読むため。書き込みは
`save_daily_report_full` 等の RPC 経由なので、テーブルへの直接書き込みは
閉じてよい。これで「anon キーを持っていれば全データを消せる」状態が
無くなる。

`SECURITY DEFINER` の関数は所有者権限で動くため RLS を迂回する。
既存の RPC はすべてそのまま動作する。

### 実行後の確認

ファイル末尾の確認クエリで、各テーブルの RLS 有効状態とポリシー数を
一覧できる。期待値もコメントに書いてある。

動作確認は次の順で:

1. `/store/<slug>/today` … 日報の表示・保存
2. `/store/<slug>/clock` … 打刻
3. `/dashboard` `/monthly` `/attendance` … 管理画面(ログイン済み)
4. `/public-dashboard` … 未認証で表示できるか

### 残る論点: 公開ダッシュボード

`/public-dashboard` は認証不要で売上を表示する。この URL を知っていれば
誰でも売上を見られるため、Tier 2 で `daily_reports` の anon SELECT を
許可せざるを得ない。

売上を非公開にしたい場合は `/public-dashboard` を廃止し、
`daily_reports` `shift_entries` `order_lines` `report_answers` の
SELECT を authenticated のみに絞るとよい(店舗画面はこれらを
`get_today_full` 経由で読んでいるので影響しない)。

---

## Step 17 — 勤怠の15分丸め

`21_quarter_hour_rounding.sql` を移行先 SQL Editor で1回実行する。

### 丸めルール

| 対象 | 丸め | 例 |
|---|---|---|
| 出勤時刻 | 切り上げ | 09:01 → 09:15 |
| 退勤時刻 | 切り捨て | 17:14 → 17:00 |
| 休憩時間 | 切り上げ | 47分 → 60分 |

出退勤とも15分境界に丸めるため差は必ず15の倍数になり、休憩も15の倍数
なので、**実働は常に 0.25 時間刻み**になる。7.3 のような値は出ない。

休憩0分は切り上げない(0分のまま)。休憩を取っていない日を15分に
してしまわないため。

### 適用範囲

丸めは2箇所に実装している。どちらも同じルール。

| | 対象 | 実装 |
|---|---|---|
| 勤怠打刻 | 打刻から集計する実働 | `clock_summary()`(この SQL) |
| 日報の実績入力 | 手入力したシフト | `shiftMinutes()`(`src/lib/calc.ts`) |

`clock_summary()` を差し替えるだけで、これを使う
`get_clock_board` / `get_attendance_summary` / `get_attendance_month`
がまとめて丸め後の値を返す。

**打刻イベント(`time_clock_events`)は実打刻のまま保持する。**
丸めは集計時にのみ適用し、原本は労務記録として残す。勤怠管理の
打刻一覧に出るのは実打刻、その上の集計に出るのは丸め後の値。

### 表示

`formatHours()` を 0.25 刻み表示に変更した(末尾の 0 は落とす)。

```
7.25 / 7.5 / 7.75 / 8
```

影響する画面: 月間レポート、勤怠管理(日別・月別)、
本部ダッシュボード、日報入力、過去日報編集。

> **注意**: この SQL は出勤・退勤時刻の表示まで丸めてしまう。
> 正しい仕様は Step 18 を参照。21 と 22 を続けて実行すること。

---

## Step 18 — 丸めを実働の計算だけに限定する

`22_round_work_minutes_only.sql` を移行先 SQL Editor で1回実行する
(`21_quarter_hour_rounding.sql` 実行済みが前提)。

**丸めが効くのは実働時間の計算時のみ。** 出勤・退勤・休憩は打刻した
実際の値をそのまま表示する。

| 項目 | 表示 | 実働計算 |
|---|---|---|
| 出勤時刻 | 09:01(打刻そのまま) | 09:15 に切り上げ |
| 退勤時刻 | 17:14(打刻そのまま) | 17:00 に切り捨て |
| 休憩時間 | 47分(実際の分数) | 60分に切り上げ |
| **実働** | — | **6.75h** |

打刻の原本を画面でそのまま確認できるようにしつつ、給与計算に使う
実働だけを15分単位に揃える運用。

`src/lib/calc.ts` 側は最初からこの形になっている
(`shiftMinutes()` は実働のみ丸め、`formatTimeRange()` は実打刻表示)
ため、変更は SQL のみ。

---

## Step 19 — 休憩の入り/戻り時刻を表示する

`23_break_times.sql` を移行先 SQL Editor で1回実行する
(`22_round_work_minutes_only.sql` 実行済みが前提)。

勤怠管理の集計に、休憩の合計分数だけでなく実際の
**「休憩入」「休憩戻」の時刻**を表示できるようにする。

### 返り値

`clock_summary()` に `breaks`(jsonb 配列)を追加した。
休憩は1日に複数回あり得るので配列で返す。

```json
[{"begin":"12:00","end":"12:47"}, {"begin":"15:00","end":"15:10"}]
```

休憩に入ったまま戻っていない場合は `end` が `null` になり、
画面には「休憩中」と表示される。

時刻は**打刻そのまま**。丸めは実働の計算時のみ(Step 18 と同じ)。

### 参照側の再作成について

`clock_summary()` は `RETURNS TABLE` の列が増えたため、
`DROP FUNCTION` してから作り直している。これを参照している

- `get_attendance_summary()`
- `get_attendance_month()`
- `get_clock_board()`
- `get_personal_clock()`

も同じ SQL 内でまとめて再作成しているので、順番を気にせず
ファイル全体を1回実行すればよい。

### 画面

勤怠管理の日別サマリーと月別ビューに「休憩入〜戻」列を追加。

```
メンバー | 出勤  | 休憩入〜戻    | 退勤  | 休憩計 | 実働
山田     | 09:01 | 12:00〜12:47 | 17:14 | 47分   | 6.75h
```

複数回休憩した日は縦に並べて全て表示する。

---

## freee 連携のつまずき — 人事労務APIに到達できない

「接続を診断」で `hr_access.ok: false` が出る場合、**アプリ側で
人事労務にアクセスできる状態になっていない**。打刻を送る以前の段階。

### 確認する順に

**1. アプリの対象サービス**

freee 開発者ページ → アプリ設定で、**人事労務**が対象に含まれているか。
会計だけのアプリだと人事労務APIは 403 になる。含まれていなければ
人事労務を対象にしたアプリを作り直す。

**2. スコープ**

アプリ設定に表示されているスコープを確認し、そのまま Vercel の
`FREEE_SCOPE` にスペース区切りで設定する。

```
FREEE_SCOPE=hr:employees:read hr:time_clocks:write
```

設定後は**再デプロイしてから `/api/freee/auth` で接続し直す**こと。
既存のトークンは古いスコープのままなので、取り直さないと反映されない。

**3. 事業所の状態**

- 対象の事業所で freee人事労務 が使える契約になっているか
- 認可したユーザーがその事業所の人事労務にアクセスできる権限を持つか
- `FREEE_COMPANY_ID` が人事労務側の事業所IDと一致しているか
  (会計側の事業所IDと混同しやすい)

### 診断の見方

```json
{
  "hr_access": { "ok": false, "status": 403, "response": {...} },
  "scope_sent": "(未設定)",
  "company_id": "..."
}
```

`hr_access.ok` が false の間は、その先(従業員一覧・打刻)は
確認しても意味がない。まずここを true にする。

true になったら `available_types` に各スタッフの結果が並ぶので、
そこで従業員IDの正しさを確認する。

---

## freee 連携 — 認可コードが画面に表示される場合

freee アプリのコールバックURLが `urn:ietf:wg:oauth:2.0:oob` になって
いると、認可後にリダイレクトされず**画面に認可コードが表示される**。
この場合は自動のコールバック(`/api/freee/callback`)を通らないので、
コードを手で貼って交換する。

### 手順

1. 管理画面 → 勤怠管理 → freee人事労務 連携
2. 「認可コードを貼り付けて接続」欄にコードを貼る
3. 「接続する」

**認可コードは数分で失効し、一度しか使えない。** 期限切れなら
freee で認可をやり直して新しいコードを取得する。

コールバックURLが oob 以外だった場合は、折りたたみを開いて
**認可時に使ったコールバックURLと完全に一致する値**を入れる。
ここがずれると `redirect_uri_mismatch` で失敗する。

### 本来の運用に戻すには

毎回コードを貼るのは手間なので、freee アプリのコールバックURLを

```
https://<本番ホスト>/api/freee/callback
```

に変更し、`FREEE_REDIRECT_URI` にも同じ値を設定しておくとよい。
以降は `/api/freee/auth?secret=<CRON_SECRET>` を開くだけで接続が完了する。

---

## freee 連携 — invalid_authorization_company_id が出る場合

診断で `hr_access.ok: true` なのに、各スタッフが 401 で

```json
{ "message": "この事業所にアクセスする権限がありません",
  "code": "invalid_authorization_company_id" }
```

となる場合。

### 原因

**freee のアクセストークンは、認可時に選んだ事業所に紐づく。**

`/hr/api/v1/users/me` はそのユーザーがアクセスできる事業所を**すべて**
返すが、トークンが有効なのはそのうち**認可した1つだけ**。
`FREEE_COMPANY_ID` がそれと違うと、この 401 になる。

### 特定のしかた

診断は users/me に出た事業所を1つずつ試し、`companies` に結果を返す。

```json
"companies": [
  { "id": 12431094, "name": "有限会社みかわ", "accessible": true,  "is_configured": false },
  { "id": 12812948, "name": "開発用テスト事業所", "accessible": false, "is_configured": true }
]
```

`accessible: true` の事業所がトークンの認可先。

### 直しかた

**使いたい事業所の ID を `FREEE_COMPANY_ID` に設定**し、再デプロイする。
その事業所が `accessible: false` なら、認可をやり直して
**同意画面でその事業所を選択**する。

事業所を変えたら、スタッフマスタの freee従業員ID も
その事業所のものに揃っているか確認すること。
事業所が違えば従業員IDも別物になる。

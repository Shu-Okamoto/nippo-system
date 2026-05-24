# 日報システム — Phase 1

八百屋2店舗の日報・ワークスケジュール・本部注文票をデジタル化する Next.js + Supabase 製の業務アプリ。

---

> **Note**: Phase 2 から DB を DXシステム側 Supabase プロジェクトの `nippo` スキーマに移行しました。手順は [`db/migration/MIGRATION.md`](db/migration/MIGRATION.md) を参照。

## 1. セットアップ手順(Windows)

### 1.1 Supabaseプロジェクトを用意

1. DXシステム側 Supabase プロジェクトに `nippo` スキーマがある前提
2. 既存プロジェクトから移行する場合は [`db/migration/MIGRATION.md`](db/migration/MIGRATION.md) に従う
3. **Project Settings → API** から以下をメモ
   - Project URL
   - anon public key

### 1.2 ローカル起動

PowerShell で:

```powershell
cd nippo-system
npm install
```

`.env.local.example` をコピーして `.env.local` を作成、Supabaseキーを貼る:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
```

起動:

```powershell
npm run dev
```

ブラウザで http://localhost:3000 を開く。

### 1.3 本部ユーザを作る

Supabaseダッシュボード → **Authentication → Users → Add user**
メール/パスワードを入力して作成。
http://localhost:3000/login からログイン。

---

## 2. 画面一覧

| URL | 説明 | 認証 |
|---|---|---|
| `/` | トップ(ナビ) | 不要 |
| `/store/iwakuni/today` | 岩国本店 日報入力 | 不要 |
| `/store/dai2/today` | 第二店舗 日報入力 | 不要 |
| `/login` | 本部ログイン | — |
| `/dashboard` | 本部ダッシュボード | 必要 |
| `/admin` | マスタ管理(店舗/スタッフ/商品) | 必要 |
| `/api/order-pdf?date=YYYY-MM-DD` | 注文票PDF | 必要(将来) |

---

## 3. テスト観点

### 3.1 スタッフ画面 `/store/iwakuni/today`

- [ ] スマホ実機/Chromeデベロッパーツール(iPhone表示)で開く
- [ ] 天気の絵文字ボタンがタップで選択切替できる
- [ ] 売上予測・実績・客数が3桁カンマで表示される
- [ ] 客単価が客数入力時に自動算出される
- [ ] **シフト予定タブ**で「前半/後半/通し」のボタン3択で入力できる
- [ ] **通し**を選ぶと休憩時間入力が出現
- [ ] **シフト実績タブ**で出退勤時刻+休憩入出時刻が入力できる
- [ ] ガントバーがシフト入力に応じて動く
- [ ] 総時間数が自動算出される
- [ ] 人時売が画面下部に表示される(売上実績÷総時間)
- [ ] 注文の +/− ボタンが動く、数量0は薄色
- [ ] 入力後、画面上部に「✓ 保存済み HH:MM」が出る
- [ ] ブラウザリロード後も入力内容が復元される

### 3.2 本部ダッシュボード `/dashboard`

- [ ] ログインなしでアクセスすると `/login` にリダイレクト
- [ ] ログイン後、KPIストリップに当日の人時売・売上・労働時間が表示
- [ ] 各店舗カードに人時売・客単価などが並ぶ
- [ ] 日付ピッカーで過去日付に切り替えられる
- [ ] 「注文票PDF出力」ボタンでPDFがダウンロード(または新タブで開く)

### 3.3 マスタ管理 `/admin`

- [ ] 店舗マスタ: 一覧表示、新規追加、停止/復帰が動く
- [ ] スタッフマスタ: 一覧表示、新規追加、停止/復帰が動く
- [ ] 商品マスタ: 19品目の初期データが表示、追加・停止が動く

### 3.4 データ連携

- [ ] マスタで追加したスタッフがシフト入力のプルダウンに出る
- [ ] マスタで追加した商品がスタッフ画面の注文行に出る
- [ ] スタッフ画面で入力した日報が本部ダッシュボードに反映される

---

## 4. 既知の制限(Phase 1)

- スタッフ画面はURL slugが分かれば誰でも閲覧可能(本来は店舗ごとの認証なし運用前提)
- 過去日報のスタッフ画面からの編集は当日のみ
- 本部ダッシュボードの「曜日別ランキング」「店舗別ランキング」はPhase 2
- 商品のカテゴリ別グルーピング表示(スタッフ画面)はPhase 2
- PWA設定(manifest.json)は未設定、必要に応じて追加

---

## 5. Vercelデプロイ

1. GitHubにpush
2. [Vercel](https://vercel.com) で **New Project → Import**
3. Environment Variables に `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` を設定
4. Deploy

デプロイ後、店舗スマホで以下をホーム画面追加:
- `https://YOUR-DOMAIN.vercel.app/store/iwakuni/today`
- `https://YOUR-DOMAIN.vercel.app/store/dai2/today`

---

## 6. トラブルシュート

### `Cannot find module '@supabase/supabase-js'`
→ `npm install` を実行

### `NEXT_PUBLIC_SUPABASE_URL is not defined`
→ `.env.local` を確認、`npm run dev` を再起動

### 「店舗が見つかりません」
→ SupabaseでSQL流し込みが完了しているか、`stores`テーブルに `iwakuni`/`dai2` のslugがあるか確認

### PDF生成エラー
→ サーバーサイドで実行される。`renderToBuffer` のエラーは `npm run dev` のターミナルに出力される

### シフトが保存されない
→ Supabase SQL Editorで `select * from shift_entries;` を実行してDB側を確認

---

## 7. ディレクトリ構造

```
src/
├── app/
│   ├── (admin)/           本部画面(認証必須)
│   │   ├── layout.tsx     認証ガード+ナビヘッダ
│   │   ├── dashboard/     ダッシュボード
│   │   └── admin/         マスタ管理
│   ├── store/[slug]/today/ スタッフ画面
│   ├── api/order-pdf/     PDF出力API
│   ├── login/             ログイン
│   ├── layout.tsx         ルートレイアウト
│   ├── globals.css
│   └── page.tsx           トップ
├── components/
│   ├── staff/             スタッフ画面UI部品
│   └── admin/             マスタ管理UI部品
└── lib/
    ├── supabase.ts        Supabaseクライアント
    ├── types.ts           TypeScript型定義
    └── calc.ts            人時売・客単価・シフト時間計算
```

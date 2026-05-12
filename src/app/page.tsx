import Link from 'next/link';

export default function Home() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="font-mincho text-3xl font-extrabold mb-2">日報システム</h1>
      <p className="text-sm text-muted font-mono mb-8">STORE DAILY REPORT · PHASE 1</p>

      <section className="mb-8 border-2 border-ink bg-paper p-6 shadow-ink">
        <h2 className="font-mincho text-xl font-bold mb-4">店舗スタッフ向け</h2>
        <p className="text-sm mb-4 text-muted">各店舗のスマホで以下URLをブックマーク・ホーム画面追加してください。</p>
        <ul className="space-y-2">
          <li>
            <Link href="/store/nishi/today" className="block border-2 border-ink p-3 hover:bg-paper2 font-bold">
              ▸ 西店 日報入力 <span className="font-mono text-xs ml-2 text-muted">/store/nishi/today</span>
            </Link>
          </li>
          <li>
            <Link href="/store/minami/today" className="block border-2 border-ink p-3 hover:bg-paper2 font-bold">
              ▸ 南店 日報入力 <span className="font-mono text-xs ml-2 text-muted">/store/minami/today</span>
            </Link>
          </li>
        </ul>
      </section>

      <section className="border-2 border-ink bg-paper p-6 shadow-ink">
        <h2 className="font-mincho text-xl font-bold mb-4">本部</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/dashboard" className="block border-2 border-ink p-3 hover:bg-paper2 font-bold">
              ▸ 本部ダッシュボード
            </Link>
          </li>
          <li>
            <Link href="/admin" className="block border-2 border-ink p-3 hover:bg-paper2 font-bold">
              ▸ マスタ管理
            </Link>
          </li>
          <li>
            <Link href="/login" className="block border-2 border-ink p-3 hover:bg-paper2 font-bold">
              ▸ ログイン
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

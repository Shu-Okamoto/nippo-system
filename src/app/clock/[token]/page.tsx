import { PersonalClock } from '@/components/staff/PersonalClock';

// 個人専用の打刻画面。LINE から配る URL がここに来る。
// トークンが URL に含まれるので、検索エンジンには載せない。
export const metadata = {
  robots: { index: false, follow: false },
};

export default function PersonalClockPage({ params }: { params: { token: string } }) {
  return <PersonalClock token={params.token} />;
}

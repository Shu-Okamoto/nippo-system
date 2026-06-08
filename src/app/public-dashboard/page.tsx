'use client';
import { DashboardView } from '@/components/dashboard/DashboardView';

// 認証不要の公開ダッシュボード
// (admin) レイアウト配下ではないため、ログインガードもナビヘッダも無し
export default function PublicDashboardPage() {
  return <DashboardView />;
}

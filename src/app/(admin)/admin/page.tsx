'use client';
import { useState } from 'react';
import { StoresMaster } from '@/components/admin/StoresMaster';
import { StaffMaster } from '@/components/admin/StaffMaster';
import { ProductsMaster } from '@/components/admin/ProductsMaster';

type Tab = 'store' | 'staff' | 'product';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('store');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="font-mincho text-3xl font-extrabold">マスタ管理</h1>
        <p className="text-xs text-muted font-mono mt-1 tracking-wider">STORES · STAFF · PRODUCTS</p>
      </div>

      <div className="flex border-2 border-ink mb-6 bg-paper">
        {[
          { k: 'store' as Tab, label: '店舗マスタ' },
          { k: 'staff' as Tab, label: 'スタッフマスタ' },
          { k: 'product' as Tab, label: '商品マスタ' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`flex-1 py-3.5 font-mincho font-bold tracking-wider border-r-2 border-ink last:border-r-0 ${
              tab === t.k ? 'bg-ink text-paper' : ''
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'store' && <StoresMaster />}
      {tab === 'staff' && <StaffMaster />}
      {tab === 'product' && <ProductsMaster />}
    </div>
  );
}

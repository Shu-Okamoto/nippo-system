'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Staff, Store, StaffRole, StaffPrivate } from '@/lib/types';

const ROLE_LABEL: Record<StaffRole, string> = { head: '店責', part: 'パート', support: '応援' };

export function StaffMaster() {
  const [rows, setRows] = useState<Staff[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [privateMap, setPrivateMap] = useState<Record<number, StaffPrivate>>({});
  const [newRow, setNewRow] = useState<{ name: string; store_id: number | null; role: StaffRole }>({
    name: '',
    store_id: null,
    role: 'part',
  });

  const load = async () => {
    setLoading(true);
    const [{ data: s }, { data: st }, { data: pv }] = await Promise.all([
      supabase.from('staff').select('*').order('store_id').order('sort_order'),
      supabase.from('stores').select('*').order('id'),
      // PIN の有無と時給。ハッシュは返らない
      supabase.rpc('get_staff_private'),
    ]);
    setRows(s || []);
    setStores(st || []);
    const map: Record<number, StaffPrivate> = {};
    for (const p of ((pv || []) as StaffPrivate[])) map[p.staff_id] = p;
    setPrivateMap(map);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addRow = async () => {
    if (!newRow.name || !newRow.store_id) {
      alert('氏名と所属店舗は必須です');
      return;
    }
    const maxSort = rows.filter((r) => r.store_id === newRow.store_id).length;
    const { error } = await supabase.from('staff').insert({ ...newRow, sort_order: maxSort + 1 });
    if (error) {
      alert(error.message);
      return;
    }
    setNewRow({ name: '', store_id: null, role: 'part' });
    load();
  };

  const toggleActive = async (id: number, current: boolean) => {
    const { error } = await supabase.from('staff').update({ is_active: !current }).eq('id', id);
    if (error) {
      alert(`状態を変更できませんでした: ${error.message}`);
      return;
    }
    load();
  };

  const deleteRow = async (r: Staff) => {
    // shift_entries.staff_id は ON DELETE SET NULL。
    // 削除すると過去シフトの名前が「(未設定)」になるので件数を出して警告する
    const { count } = await supabase
      .from('shift_entries')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', r.id);

    const used = (count ?? 0) > 0;
    const msg = used
      ? `「${r.name}」は過去のシフト ${count} 件に記録されています。\n削除すると過去の日報・月間レポートで名前が「(未設定)」と表示されます。\n\n退職の場合は履歴が残る「停止」を推奨します。それでも削除しますか?`
      : `「${r.name}」を削除します。よろしいですか?`;
    if (!confirm(msg)) return;

    const { error } = await supabase.from('staff').delete().eq('id', r.id);
    if (error) {
      alert(`削除できませんでした: ${error.message}`);
      return;
    }
    load();
  };

  const storeName = (id: number) => stores.find((s) => s.id === id)?.name || `店舗${id}`;

  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;

  return (
    <div>
      <PunchPinSetting />

      <table className="w-full border-2 border-ink bg-paper text-sm">
        <thead className="bg-ink text-paper">
          <tr>
            <th className="p-2.5 text-left w-16">ID</th>
            <th className="p-2.5 text-left">氏名</th>
            <th className="p-2.5 text-left">所属店舗</th>
            <th className="p-2.5 text-left">区分</th>
            <th className="p-2.5 text-center">並び順</th>
            <th className="p-2.5 text-center w-28">時給</th>
            <th className="p-2.5 text-center w-40">打刻PIN</th>
            <th className="p-2.5 text-center w-44">個人打刻URL</th>
            <th className="p-2.5 text-center w-32">freee従業員ID</th>
            <th className="p-2.5 text-center">状態</th>
            <th className="p-2.5 text-center w-40">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b border-ink ${!r.is_active ? 'text-stone-400' : ''}`}>
              <td className="p-2.5 font-mono">{r.id}</td>
              <td className="p-2.5">{r.name}</td>
              <td className="p-2.5">{storeName(r.store_id)}</td>
              <td className="p-2.5">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.role === 'head' ? 'bg-ink text-paper' : r.role === 'part' ? 'bg-amber-100' : 'bg-paper2'
                }`}>
                  {ROLE_LABEL[r.role]}
                </span>
              </td>
              <td className="p-2.5 text-center font-mono">{r.sort_order}</td>
              <td className="p-2 text-center">
                <WageInput staffId={r.id} value={privateMap[r.id]?.hourly_wage ?? null} onSaved={load} />
              </td>
              <td className="p-2 text-center">
                <PinCell staffId={r.id} name={r.name} info={privateMap[r.id]} onSaved={load} />
              </td>
              <td className="p-2 text-center">
                <ClockLinkCell staffId={r.id} name={r.name} info={privateMap[r.id]} onSaved={load} />
              </td>
              <td className="p-2 text-center">
                <FreeeIdInput row={r} onSaved={load} />
              </td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-paper2' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '稼働' : '停止'}
                </span>
              </td>
              <td className="p-2.5 text-center whitespace-nowrap">
                <button
                  onClick={() => toggleActive(r.id, r.is_active)}
                  className={`text-xs px-2.5 py-1 border-1.5 border-ink font-bold mr-1.5 ${
                    r.is_active ? 'text-accent border-accent' : ''
                  }`}
                >
                  {r.is_active ? '停止' : '復帰'}
                </button>
                <button
                  onClick={() => deleteRow(r)}
                  className="text-xs px-2.5 py-1 border-1.5 border-accent text-paper bg-accent font-bold"
                >
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 p-4 bg-paper2 border-2 border-dashed border-ink">
        <b className="font-mincho block mb-2.5">＋ 新規スタッフを追加</b>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            placeholder="氏名"
            value={newRow.name}
            onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[160px]"
          />
          <select
            value={newRow.store_id ?? ''}
            onChange={(e) => setNewRow({ ...newRow, store_id: e.target.value ? Number(e.target.value) : null })}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            <option value="">所属店舗</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={newRow.role}
            onChange={(e) => setNewRow({ ...newRow, role: e.target.value as StaffRole })}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            <option value="head">店責</option>
            <option value="part">パート</option>
            <option value="support">応援</option>
          </select>
          <button
            onClick={addRow}
            className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm"
          >
            追加
          </button>
        </div>
      </div>
    </div>
  );
}

// freee人事労務の従業員ID。フォーカスが外れた時に保存する
function FreeeIdInput({ row, onSaved }: { row: Staff; onSaved: () => void }) {
  const [value, setValue] = useState(
    row.freee_employee_id === null || row.freee_employee_id === undefined
      ? ''
      : String(row.freee_employee_id)
  );

  useEffect(() => {
    setValue(
      row.freee_employee_id === null || row.freee_employee_id === undefined
        ? ''
        : String(row.freee_employee_id)
    );
  }, [row.id, row.freee_employee_id]);

  const save = async () => {
    const trimmed = value.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && !Number.isInteger(next)) {
      alert('freee従業員IDは整数で入力してください');
      return;
    }
    if (next === (row.freee_employee_id ?? null)) return;

    const { error } = await supabase
      .from('staff')
      .update({ freee_employee_id: next })
      .eq('id', row.id);
    if (error) {
      alert(`保存できませんでした: ${error.message}`);
      return;
    }
    onSaved();
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={save}
      placeholder="未設定"
      className="w-24 p-1 border-1.5 border-ink bg-paper text-xs font-mono text-center"
    />
  );
}

// 時給。フォーカスが外れた時に保存する
function WageInput({
  staffId,
  value,
  onSaved,
}: {
  staffId: number;
  value: number | null;
  onSaved: () => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));

  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [staffId, value]);

  const save = async () => {
    const trimmed = text.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next === (value ?? null)) return;

    const { error } = await supabase.rpc('set_staff_wage', {
      p_staff_id: staffId,
      p_hourly_wage: next,
    });
    if (error) {
      alert(`時給を保存できませんでした: ${error.message}`);
      return;
    }
    onSaved();
  };

  return (
    <div className="flex items-center justify-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={save}
        placeholder="未設定"
        className="w-20 p-1 border-1.5 border-ink bg-paper text-xs font-mono text-right"
      />
      <span className="text-[10px] text-muted">円</span>
    </div>
  );
}

// 打刻PIN。ハッシュは取得できないので、発行・再発行・解除だけを行う
function PinCell({
  staffId,
  name,
  info,
  onSaved,
}: {
  staffId: number;
  name: string;
  info: StaffPrivate | undefined;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const hasPin = info?.has_pin ?? false;

  const savePin = async (pin: string | null) => {
    setBusy(true);
    const { error } = await supabase.rpc('set_staff_pin', {
      p_staff_id: staffId,
      p_pin: pin,
    });
    setBusy(false);
    if (error) {
      alert(`PINを設定できませんでした: ${error.message}`);
      return;
    }
    onSaved();
  };

  const issue = async () => {
    const input = prompt(
      `${name} さんの打刻PINを設定します。\n4〜6桁の数字を入力してください。`,
      ''
    );
    if (input === null) return;
    const pin = input.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      alert('PINは4〜6桁の数字で入力してください');
      return;
    }
    await savePin(pin);
    alert(`${name} さんのPINを設定しました。\n本人に「${pin}」を伝えてください。`);
  };

  const clear = async () => {
    if (!confirm(`${name} さんのPINを解除します。\n解除すると打刻できなくなります。よろしいですか?`)) {
      return;
    }
    await savePin(null);
  };

  return (
    <div className="flex items-center justify-center gap-1.5">
      <span
        className={`inline-block px-2 py-0.5 text-[10px] font-bold border-1.5 border-ink ${
          info?.locked
            ? 'bg-accent text-paper'
            : hasPin
            ? 'bg-accent2 text-paper'
            : 'bg-stone-300'
        }`}
      >
        {info?.locked ? 'ロック中' : hasPin ? '設定済' : '未設定'}
      </span>
      <button
        onClick={issue}
        disabled={busy}
        className="text-[10px] px-2 py-1 border-1.5 border-ink font-bold"
      >
        {hasPin ? '再発行' : '発行'}
      </button>
      {hasPin && (
        <button
          onClick={clear}
          disabled={busy}
          className="text-[10px] px-2 py-1 border-1.5 border-accent text-accent font-bold"
        >
          解除
        </button>
      )}
    </div>
  );
}

// 打刻時にPINを求めるかどうかの全体設定(全員一律)
function PunchPinSetting() {
  const [requirePin, setRequirePin] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = await supabase.rpc('get_app_settings');
    setRequirePin((data as any)?.require_punch_pin ?? true);
  };

  useEffect(() => {
    load();
  }, []);

  const toggle = async (next: boolean) => {
    const msg = next
      ? '打刻時にPIN入力を求めます。\nPIN未設定のメンバーは打刻できなくなります。よろしいですか?'
      : '打刻時のPIN入力を不要にします。\n名前を選ぶだけで誰でも打刻できる状態になります。よろしいですか?';
    if (!confirm(msg)) return;

    setBusy(true);
    const { error } = await supabase.rpc('set_require_punch_pin', { p_require: next });
    setBusy(false);
    if (error) {
      alert(`設定を変更できませんでした: ${error.message}`);
      return;
    }
    setRequirePin(next);
  };

  if (requirePin === null) return null;

  return (
    <div className="mb-4 p-4 border-2 border-ink bg-paper2 flex flex-wrap items-center gap-4">
      <div className="flex-1 min-w-[260px]">
        <b className="font-mincho block mb-1">打刻時のPIN入力</b>
        <p className="text-xs text-muted leading-relaxed">
          {requirePin
            ? '打刻画面で名前を選んだあと、本人のPIN入力が必要です。'
            : '名前を選ぶだけで打刻できます。PINの設定内容は保持されるので、いつでも「必要」に戻せます。'}
        </p>
      </div>
      <div className="flex border-2 border-ink">
        {[
          { v: true, label: '必要' },
          { v: false, label: '不要' },
        ].map((o) => (
          <button
            key={String(o.v)}
            onClick={() => requirePin !== o.v && toggle(o.v)}
            disabled={busy}
            className={`px-5 py-2.5 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
              requirePin === o.v ? 'bg-ink text-paper' : 'bg-paper'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// 個人専用の打刻URL。DX 側の LINE 配信に渡す想定
function ClockLinkCell({
  staffId,
  name,
  info,
  onSaved,
}: {
  staffId: number;
  name: string;
  info: StaffPrivate | undefined;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const token = info?.clock_token ?? null;

  // SSR 時は window が無いので、実際に押された時に組み立てる
  const urlOf = (t: string) => `${window.location.origin}/clock/${t}`;

  const issue = async (force: boolean) => {
    if (force && !confirm(`${name} さんの打刻URLを再発行します。\n今までのURLは使えなくなります。よろしいですか?`)) {
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('issue_clock_token', {
      p_staff_id: staffId,
      p_force: force,
    });
    setBusy(false);
    if (error) {
      alert(`URLを発行できませんでした: ${error.message}`);
      return;
    }
    onSaved();
    await copy(urlOf(data as string));
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      alert(`打刻URLをコピーしました。\n\n${url}`);
    } catch {
      // クリップボードが使えない環境では手でコピーしてもらう
      prompt('打刻URL(コピーしてください)', url);
    }
  };

  const revoke = async () => {
    if (!confirm(`${name} さんの打刻URLを失効させます。\nLINEで配ったURLは使えなくなります。よろしいですか?`)) {
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('revoke_clock_token', { p_staff_id: staffId });
    setBusy(false);
    if (error) {
      alert(`失効できませんでした: ${error.message}`);
      return;
    }
    onSaved();
  };

  if (!token) {
    return (
      <button
        onClick={() => issue(false)}
        disabled={busy}
        className="text-[10px] px-2 py-1 border-1.5 border-ink font-bold"
      >
        URL発行
      </button>
    );
  }

  return (
    <div className="flex items-center justify-center gap-1.5 flex-wrap">
      <button
        onClick={() => copy(urlOf(token))}
        disabled={busy}
        className="text-[10px] px-2 py-1 border-1.5 border-ink font-bold bg-ink text-paper"
      >
        コピー
      </button>
      <button
        onClick={() => issue(true)}
        disabled={busy}
        className="text-[10px] px-2 py-1 border-1.5 border-ink font-bold"
      >
        再発行
      </button>
      <button
        onClick={revoke}
        disabled={busy}
        className="text-[10px] px-2 py-1 border-1.5 border-accent text-accent font-bold"
      >
        失効
      </button>
    </div>
  );
}

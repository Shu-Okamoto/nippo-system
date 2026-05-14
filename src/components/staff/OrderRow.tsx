'use client';

export function OrderRow({
  name,
  qty,
  isManual,
  onChange,
  onDelete,
}: {
  name: string;
  qty: number;
  isManual?: boolean;
  onChange: (v: number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2 py-2.5 border-b border-dashed border-ink last:border-b-0">
      <span className="text-base font-medium flex items-center gap-1.5 min-w-0">
        <span className="truncate">{name}</span>
        {isManual && (
          <span className="shrink-0 text-[9px] font-bold px-1 py-0.5 border border-ink bg-amber-100 font-mono">
            臨時
          </span>
        )}
      </span>
      <button
        onClick={() => onChange(Math.max(0, qty - 1))}
        className="w-9 h-9 border-2 border-ink bg-paper font-mono text-lg font-extrabold hover:bg-paper2"
      >
        −
      </button>
      <span className={`w-12 text-center font-mono text-lg font-bold ${qty === 0 ? 'text-stone-400' : ''}`}>
        {qty}
      </span>
      <button
        onClick={() => onChange(qty + 1)}
        className="w-9 h-9 border-2 border-ink bg-paper font-mono text-lg font-extrabold hover:bg-paper2"
      >
        +
      </button>
      <button
        onClick={onDelete}
        className="w-7 h-9 text-accent text-base font-bold"
        title="削除"
      >
        ×
      </button>
    </div>
  );
}

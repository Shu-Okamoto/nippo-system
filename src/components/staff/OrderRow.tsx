'use client';

export function OrderRow({
  name,
  qty,
  onChange,
}: {
  name: string;
  qty: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 py-2.5 border-b border-dashed border-ink last:border-b-0">
      <span className="text-base font-medium">{name}</span>
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
    </div>
  );
}

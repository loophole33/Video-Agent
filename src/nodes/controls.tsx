import { cn } from '../lib/utils';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={cn(
        'inline-flex rounded-md border border-bay-700 bg-bay-950 p-[2px]',
        size === 'sm' ? 'gap-[1px]' : 'gap-[2px]',
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[4px] font-mono transition-colors',
            size === 'sm' ? 'px-1.5 py-[2px] text-[11.5px]' : 'px-2 py-[3px] text-[12.5px]',
            value === o.value
              ? 'bg-sodium-500 text-bay-950 font-medium'
              : 'text-bone-400 hover:bg-bay-800 hover:text-bone-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-bay-700 accent-sodium-500
                   [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none
                   [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-sodium-500"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[12px] tabular-nums text-bone-300">
        {value}
        {suffix ?? ''}
      </span>
    </div>
  );
}

export function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="eyebrow block">{label}</span>
      {children}
    </label>
  );
}

import { Indicator } from './Indicator.tsx';

// An animated search icon: the magnifier floats in all directions while a short line sweeps across the lens.
export function SearchingIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <g className="animate-drift-x motion-reduce:animate-none">
        <g className="animate-drift-y motion-reduce:animate-none">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m20.5 20.5-4.7-4.7" />
          <g className="animate-sweep-x motion-reduce:animate-none">
            <path d="M10.5 8.5v4" />
          </g>
        </g>
      </g>
    </Indicator>
  );
}

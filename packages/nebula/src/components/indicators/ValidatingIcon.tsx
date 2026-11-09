import { Indicator } from './Indicator.tsx';

// An animated file: a line wider than the page scans it from top to bottom while the file stays still.
export function ValidatingIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z" />
      <path d="M14 2.5v5h5" />
      <g className="animate-scan motion-reduce:animate-none" strokeWidth={2.25}>
        <path d="M3.5 10.5h18" />
      </g>
    </Indicator>
  );
}

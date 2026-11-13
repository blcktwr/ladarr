import { Indicator } from './Indicator.tsx';

// An animated clock: the hands turn slowly, because the title has no release yet.
export function UpcomingIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      <circle cx="12" cy="12" r="9.5" />
      <g className="origin-center animate-tick motion-reduce:animate-none">
        <path d="M12 6.5V12l3.5 2" />
      </g>
    </Indicator>
  );
}

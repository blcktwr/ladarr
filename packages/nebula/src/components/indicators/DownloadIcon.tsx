import { Indicator } from './Indicator.tsx';

// An animated download icon: a bold arrow falls into the tray, then lifts again.
// It takes the colour of the text. A screen reader does not read it, as it is a decoration beside the values.
export function DownloadIcon({ className }: { className?: string }) {
  return (
    <Indicator className={className}>
      {/* The arrow falls. The tray takes its weight with a small dip, so the arrow reads as one part that moves. */}
      <g className="animate-drop motion-reduce:animate-none" strokeWidth={2.5}>
        <path d="M12 3v10" />
        <path d="m7.5 8.5 4.5 4.5 4.5-4.5" />
      </g>
      <g className="animate-tray motion-reduce:animate-none">
        <path d="M6 15.5v2.25A2.25 2.25 0 0 0 8.25 20h7.5A2.25 2.25 0 0 0 18 17.75V15.5" />
      </g>
    </Indicator>
  );
}

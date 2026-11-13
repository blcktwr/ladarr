import type { ReactNode } from 'react';

// The fill of each tone: a flat tint of its color, with the text in that color. Only accent is solid.
const tones = {
  neutral: 'bg-haze/10 text-ink',
  accent: 'bg-accent text-night',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-error/15 text-error',
};

type BadgeProps = {
  children: ReactNode;
  tone?: keyof typeof tones;
  width?: string;
  className?: string;
  // A badge with a click is a button. label is its accessible name, for a screen reader.
  onClick?: () => void;
  label?: string;
};

// A badge is a flat pill with no relief, so that it does not look like a key.
// tone changes the fill. Use an icon with a tone, so a person can find the tone without the color.
// width keeps the badge at one size while its value changes length, such as a count.
// className is for layout only, such as a margin.
export function Badge({ children, tone = 'neutral', width, className = '', onClick, label }: BadgeProps) {
  const shape = `${tones[tone]} box-border inline-flex items-center gap-1.5 h-6 ${width ? 'justify-center px-0' : 'px-2.5'} rounded-full text-[13px]/none font-[550] tracking-[.01em] whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0 ${className}`;
  if (onClick) {
    return (
      <button type="button" aria-label={label} onClick={onClick} style={width ? { width } : undefined} className={`${shape} cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2`}>
        {children}
      </button>
    );
  }
  return (
    <span style={width ? { width } : undefined} className={shape}>
      {children}
    </span>
  );
}

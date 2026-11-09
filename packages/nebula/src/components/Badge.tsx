import type { ReactNode } from 'react';

// The fill of each tone: a flat tint of its color, with the text in that color. Only accent is solid.
const tones = {
  neutral: 'bg-haze/10 text-ink',
  accent: 'bg-accent text-night',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-error/15 text-error',
};

type BadgeProps = { children: ReactNode; tone?: keyof typeof tones; className?: string };

// A badge is a flat pill with no relief, so that it does not look like a key.
// tone changes the fill. Use an icon with a tone, so a person can find the tone without the color.
// className is for layout only, such as a margin.
export function Badge({ children, tone = 'neutral', className = '' }: BadgeProps) {
  return (
    <span className={`${tones[tone]} box-border inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[13px]/none font-[550] tracking-[.01em] whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0 ${className}`}>
      {children}
    </span>
  );
}

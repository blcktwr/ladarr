import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton.tsx';

// The type scale. Each variant has its own element, so the headings keep their order on the page.
// The bar is the skeleton of the text while it loads. Its height and its margin make one line of the text.
const variants = {
  title: { Tag: 'h1', style: 'text-ink-strong text-[28px]/9 font-semibold', bar: 'h-6 my-1.5 w-72' },
  heading: { Tag: 'h2', style: 'text-ink text-[20px]/7 font-semibold', bar: 'h-4 my-1.5 w-48' },
  body: { Tag: 'p', style: 'text-ink text-[15px]/6', bar: 'h-3.5 my-1.25 w-96' },
  small: { Tag: 'p', style: 'text-fog text-[13px]/5', bar: 'h-3 my-1 w-16' },
} as const;

type TextProps = { variant?: keyof typeof variants; loading?: boolean; children?: ReactNode; className?: string };

// A text of the type scale: the title of a page, the heading of a part of a page, body text, or small text such as a year.
// While loading is on, a skeleton of one line shows in place of the text.
// className is for layout only, such as a margin.
export function Text({ variant = 'body', loading = false, children, className = '' }: TextProps) {
  const { Tag, style, bar } = variants[variant];
  return (
    <Tag aria-busy={loading || undefined} className={`${style} ${className}`}>
      {loading ? <Skeleton className={`${bar} max-w-full`} /> : children}
    </Tag>
  );
}

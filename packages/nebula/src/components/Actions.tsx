import type { ReactNode } from 'react';

// A row of buttons. On a narrow screen it goes on more than one row.
export function Actions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>;
}

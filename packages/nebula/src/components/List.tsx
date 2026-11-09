import type { ReactNode } from 'react';

// A list of rows, with space between them. Put a Row in it for each item.
export function List({ children }: { children: ReactNode }) {
  return <ul className="grid grid-cols-[minmax(0,1fr)] gap-4 w-full">{children}</ul>;
}

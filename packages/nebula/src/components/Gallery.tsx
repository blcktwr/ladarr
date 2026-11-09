import type { ReactNode } from 'react';

// A group of thumbnails, such as a catalog or a cast. They go on more than one row, with the same space between them on each page.
// The thumbnails align to the left of the row, also when the row is not full.
// It lies on the page without a pane, as a Thumbnail does.
export function Gallery({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-start gap-x-6 gap-y-8">{children}</div>;
}

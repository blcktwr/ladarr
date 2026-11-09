import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ghost, key, sunk } from '../theme/stone.ts';

type PaginationProps = {
  // The current page, from 1.
  page: number;
  // The number of pages.
  count: number;
  // Called with the page that the person selects.
  onPageChange: (page: number) => void;
  // The accessible name of the list, such as "Pages".
  'aria-label': string;
  className?: string;
};

// A page number is a key, as an icon-only Button: square, 44px.
const pageKey = `${key} inline-flex items-center justify-center size-11 rounded-md cursor-pointer [&>svg]:size-4.5 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 disabled:opacity-35 disabled:pointer-events-none`;

// The pages of a table, below it: the previous page, the numbers and the next page.
// The numbers are ghost keys, and the current page is sunk. The previous key fades on the first page, and the next key fades on the last page.
// className is for layout only, such as a margin.
export function Pagination({ page, count, onPageChange, 'aria-label': label, className = '' }: PaginationProps) {
  const pages = Array.from({ length: count }, (_, index) => index + 1);
  return (
    <nav aria-label={label} className={`flex flex-wrap items-center justify-end gap-2 ${className}`}>
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className={`${pageKey} ${ghost}`}>
        <ChevronLeft />
      </button>
      {pages.map(number => (
        <button
          key={number}
          type="button"
          aria-label={`Page ${number}`}
          aria-current={number === page ? 'page' : undefined}
          onClick={() => onPageChange(number)}
          className={`${pageKey} ${number === page ? sunk : ghost}`}
        >
          {number}
        </button>
      ))}
      <button type="button" aria-label="Next page" disabled={page >= count} onClick={() => onPageChange(page + 1)} className={`${pageKey} ${ghost}`}>
        <ChevronRight />
      </button>
    </nav>
  );
}

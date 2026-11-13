import type { ReactNode } from 'react';

type DetailItem = {
  label: string;
  value: ReactNode;
  // The item takes the full row, for a long value such as the name of a release.
  wide?: boolean;
};

type DetailsProps = { items: DetailItem[]; columns?: 4 };

// A list of label and value pairs, with the layout of a field: the label above the value.
// The values take as many columns as the width fits. A long value can take the full row.
// With columns 4, four fields share one row. On a narrow screen, the first field takes the width that is left.
export function Details({ items, columns }: DetailsProps) {
  return (
    <dl className={`grid ${columns === 4 ? 'grid-cols-[minmax(0,1fr)_repeat(3,max-content)] max-sm:gap-x-2 sm:grid-cols-4' : 'grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]'} gap-x-6 gap-y-5 w-full`}>
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className={`grid content-start gap-2 min-w-0 ${item.wide ? 'col-span-full' : ''}`}>
          <dt className="text-fog text-[13px]/none font-[550]">{item.label}</dt>
          <dd className="min-w-0 text-ink-strong text-[15px]/6 font-medium [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';
import { divider, ghost, key, paneFace, tabEdge, tabRail } from '../theme/stone.ts';

export type TabItem = { value: string; label: string; content: ReactNode };

type TabHeaderProps = {
  label: string;
  items: TabItem[];
  className: string;
  children?: ReactNode;
};

export function TabHeader({ label, items, className, children }: TabHeaderProps) {
  return (
    <div className={`relative isolate flex shrink-0 items-end justify-between gap-2 ${className}`}>
      <div aria-hidden="true" className={`${tabRail} pointer-events-none absolute inset-x-0 top-0 bottom-[7px]`} />
      <div aria-hidden="true" className={`${divider} pointer-events-none absolute inset-x-0 bottom-[5px] z-10`} />
      <BaseTabs.List aria-label={label} activateOnFocus className="relative -ml-1.5 flex min-w-0 gap-1 overflow-x-auto px-1.5 pt-2 pb-[5px] [scrollbar-width:none]">
        {items.map(({ value, label }) => (
          <BaseTabs.Tab
            key={value}
            value={value}
            onClick={event => event.currentTarget.focus()}
            className={({ active }) => `${key} ${active ? `${paneFace} ${tabEdge} z-20 rounded-t-md text-ink-strong` : `${ghost} rounded-md`} relative flex h-11 shrink-0 cursor-pointer items-center justify-center px-4 pb-0.5 focus-visible:z-30 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent`}
          >
            {label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children && <div className="relative mb-[5px] shrink-0 focus-within:z-20">{children}</div>}
    </div>
  );
}

// In a stack, the tallest panel sets the height. Inactive panels stay inert and invisible.
export function TabPanels({ items, stack = false, className = '' }: { items: TabItem[]; stack?: boolean; className?: string }) {
  return items.map(({ value, content }) => (
    <BaseTabs.Panel
      key={value}
      value={value}
      keepMounted
      {...(stack && { hidden: false, render: props => <div {...props} aria-hidden={props.inert || undefined} /> })}
      className={`w-full min-w-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-accent ${stack ? `col-start-1 row-start-1 min-h-0 overflow-x-hidden overflow-y-auto [&[inert]]:opacity-0 ${className}` : ''}`}
    >
      {content}
    </BaseTabs.Panel>
  ));
}

type TabsProps = { 'aria-label': string; items: TabItem[]; className?: string };

export function Tabs({ 'aria-label': label, items, className = '' }: TabsProps) {
  return (
    <BaseTabs.Root defaultValue={items[0]?.value} className={`flex w-full min-w-0 flex-col gap-5 ${className}`}>
      <TabHeader label={label} items={items} className="px-2" />
      <TabPanels items={items} />
    </BaseTabs.Root>
  );
}

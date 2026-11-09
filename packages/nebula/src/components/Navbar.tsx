import { NavigationMenu } from '@base-ui/react/navigation-menu';
import type { ReactNode } from 'react';
import { current, ghost, tab } from '../theme/stone.ts';

type NavbarProps = {
  'aria-label': string;
  // href is where the link points, for a new tab. A plain click calls onChange with the value instead.
  // icon shows before the label, such as a Lucide icon.
  items: { value: string; label: string; icon?: ReactNode; href?: string }[];
  value: string;
  onChange: (value: string) => void;
  // The mark in the middle of the top row. It does not show on a narrow screen.
  logo?: ReactNode;
  // The start of the top row, such as a line that tells what the queue is running.
  start?: ReactNode;
  // The row under the top row, such as the search.
  children?: ReactNode;
  className?: string;
};

// The navbar is the nearest thing on screen, so it is the darkest and sharpest: a slab of black stone across
// the whole width, and the page fades into the fog below it. The top row holds the start, the logo and the menu;
// under it is a row for the search.
// The slab spans its container (the screen if there is none); its content sits in a centred 1200px column.
// On a narrow screen the menu scrolls and the rows wrap.
// className is for layout only, such as a margin.
export function Navbar({ 'aria-label': label, items, value, onChange, logo, start, children, className = '' }: NavbarProps) {
  return (
    <header className={`grid grid-cols-[minmax(0,1fr)] px-[max(20px,(100cqw_-_1200px)_/_2)] pb-4 bg-(image:--grain) bg-navbar shadow-(--navbar-edge) ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:h-18 sm:py-0">
        <div className="min-w-0 max-w-full sm:justify-self-start">{start}</div>
        <div className="max-sm:hidden">{logo}</div>
        {/* The padding keeps the focus outline and the bar of the current tab inside the scroll box. */}
        <NavigationMenu.Root aria-label={label} className="-m-4 p-4 max-w-full overflow-x-auto sm:justify-self-end">
          <NavigationMenu.List className="flex gap-1">
            {items.map(item => (
              <NavigationMenu.Item key={item.value}>
                <NavigationMenu.Link
                  href={item.href ?? '#'}
                  active={item.value === value}
                  onClick={event => {
                    // A click with a key held down keeps its meaning, such as a new tab.
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onChange(item.value);
                  }}
                  className={`${tab} ${item.value === value ? current : ghost}`}
                >
                  {item.icon}{item.label}
                </NavigationMenu.Link>
              </NavigationMenu.Item>
            ))}
          </NavigationMenu.List>
        </NavigationMenu.Root>
      </div>
      {children}
    </header>
  );
}

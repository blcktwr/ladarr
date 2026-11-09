import { Tabs } from '@base-ui/react/tabs';
import { block, ghost, key } from '../theme/stone.ts';
import { Badge } from './Badge.tsx';

type SubMenuProps = Omit<Tabs.Root.Props, 'children' | 'className' | 'orientation'> & {
  'aria-label': string;
  items: { value: string; label: string; count?: number }[];
  // The row fills the width of its container, and the items share that width.
  fill?: boolean;
  className?: string;
};

// The sections inside a page, such as the queue and the finished tasks of the activity page. The page shows the content of the selected section.
// The row is a slab of stone, as the list of a side menu. Its items are ghost keys, and the selected item is a raised block.
// count shows the number of items of the section, in a badge at the end of its key.
// On a narrow screen the items go on more than one row, so the slab and its shadow are not cut.
// className is for layout only, such as a margin.
export function SubMenu({ 'aria-label': label, items, fill = false, className = '', ...props }: SubMenuProps) {
  return (
    <Tabs.Root {...props} className={className}>
      <Tabs.List aria-label={label} className={`box-border flex flex-wrap ${fill ? 'w-full' : 'w-fit max-w-full'} p-1 rounded-lg bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink`}>
        {items.map(item => (
          <Tabs.Tab
            key={item.value}
            value={item.value}
            className={({ active }) => `${key} ${active ? block : ghost} flex items-center justify-center gap-2 h-10 px-4 rounded-[5px] cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent ${fill ? 'grow' : ''}`}
          >
            {item.label}
            {item.count !== undefined && <Badge>{item.count}</Badge>}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

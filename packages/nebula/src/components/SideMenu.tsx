import { Tabs } from '@base-ui/react/tabs';
import { currentSide, ghost, key } from '../theme/stone.ts';

type SideMenuProps = Omit<Tabs.Root.Props, 'children' | 'className' | 'orientation'> & {
  'aria-label': string;
  items: { value: string; label: string }[];
  className?: string;
};

// The list of the sections of a page, such as the parts of a settings page. The page shows the content of the selected section, in its own layout.
// The list is a slab of stone, as the list of a dropdown. The items are ghost keys, and the selected item has a short bar of the accent on the left edge of the list.
// The arrow keys move between the items, as in vertical tabs.
// className is for layout only, such as a margin.
export function SideMenu({ 'aria-label': label, items, className = '', ...props }: SideMenuProps) {
  return (
    <Tabs.Root {...props} orientation="vertical" className={className}>
      <Tabs.List aria-label={label} className="box-border flex flex-col min-w-50 p-1 rounded-lg bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
        {items.map(item => (
          <Tabs.Tab
            key={item.value}
            value={item.value}
            className={({ active }) => `${key} ${active ? currentSide : ghost} flex items-center h-10 px-3 rounded-[5px] cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent`}
          >
            {item.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

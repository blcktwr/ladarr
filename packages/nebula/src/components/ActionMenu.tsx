import { Menu } from '@base-ui/react/menu';
import { Ellipsis } from 'lucide-react';
import { ghost, key, raised, sunk } from '../theme/stone.ts';

type ActionMenuProps = {
  // The accessible name of the button, such as "More actions".
  label: string;
  // The actions, in their order. danger shows the label in red, for an action that destroys data.
  items: { label: string; onClick?: () => void; danger?: boolean; disabled?: boolean }[];
};

// A key with the dots icon that opens a list of actions. It has the size of an icon-only Button, so it fits in an Actions row.
// The trigger stays pressed in while the list is open. The list is a slab, as the list of a Dropdown, and its actions are ghost keys.
// When you select an action, the list closes. Esc also closes it. The arrow keys move between the actions.
export function ActionMenu({ label, items }: ActionMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={label}
        className={({ open }) => `${key} ${open ? sunk : raised} inline-flex items-center justify-center size-11 rounded-md cursor-pointer [&>svg]:size-4.5 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3`}
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={6}>
          <Menu.Popup className="box-border min-w-44 p-1 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
            {items.map(item => (
              <Menu.Item
                key={item.label}
                onClick={item.onClick}
                disabled={item.disabled}
                // The red stays in each state, so it overrides the colors of ghost.
                className={`${key} ${ghost} ${item.danger ? 'text-error!' : ''} flex items-center w-full h-10 px-3 rounded-[5px] cursor-pointer data-disabled:opacity-35 data-disabled:cursor-not-allowed`}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

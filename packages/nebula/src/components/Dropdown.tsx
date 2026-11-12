import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { ghost, key, raised, sunk } from '../theme/stone.ts';

const sizes = {
  sm: { trigger: 'min-w-40 h-9 px-3 gap-3', icon: '[&>svg]:size-3.5', item: 'h-9 px-2.5' },
  md: { trigger: 'min-w-50 h-11 px-3.5 gap-4', icon: '[&>svg]:size-4', item: 'h-10 px-3' },
};

type DropdownProps = Omit<Select.Root.Props<string>, 'children' | 'items'> & { options: { value: string; label?: ReactNode; disabled?: boolean }[]; label?: string; size?: keyof typeof sizes };

// The trigger is a raised key, and it stays pressed in while its list is open. The list is a slab of stone over the page.
// Its options are ghost keys, and the selected one stays pressed in. A disabled option only fades.
// A long list is 20rem tall, or as tall as the space on the screen when that is less, and it scrolls inside.
// options is a list of { value, label, disabled }. The label is the value when there is no label, and it can hold a node, such as a flag and a name.
// label is a visible label above the trigger, as the label of a field. With a label, the dropdown also keeps the place of the error row of a Field.
// Thus a Field and a Dropdown side by side have the same height, and their controls align.
// size is sm or md. The default is md, the height of a key.
export function Dropdown({ options, label, size = 'md', ...props }: DropdownProps) {
  const look = sizes[size];
  return (
    <Select.Root {...props} items={options.map(option => ({ value: option.value, label: option.label ?? option.value }))}>
      <div className="grid content-start justify-items-start gap-2">
        {label && <Select.Label className="text-ink text-[13px]/none font-[550]">{label}</Select.Label>}
        <Select.Trigger className={({ open }) => `${key} ${open ? sunk : raised} inline-flex items-center justify-between ${look.trigger} rounded-md cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 data-disabled:opacity-35 data-disabled:struck data-disabled:cursor-not-allowed`}>
          <Select.Value />
          <Select.Icon className={`flex shrink-0 text-fog transition-[rotate] duration-200 ease-stone data-popup-open:rotate-180 ${look.icon}`}>
            <ChevronDown />
          </Select.Icon>
        </Select.Trigger>
        {label && <div className="h-3.5" />}
      </div>
      <Select.Portal>
        <Select.Positioner alignItemWithTrigger={false} align="start" sideOffset={6}>
          <Select.Popup className="box-border min-w-(--anchor-width) max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
            {options.map(({ value, label: text = value, disabled }) => (
              <Select.Item
                key={value}
                value={value}
                disabled={disabled}
                className={({ selected }) => `${key} ${selected ? sunk : ghost} group flex items-center justify-between gap-6 w-full ${look.item} rounded-[5px] cursor-pointer data-disabled:opacity-35 data-disabled:cursor-not-allowed`}
              >
                <Select.ItemText>{text}</Select.ItemText>
                <Select.ItemIndicator keepMounted className={`flex text-accent invisible group-data-selected:visible ${look.icon}`}>
                  <Check />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

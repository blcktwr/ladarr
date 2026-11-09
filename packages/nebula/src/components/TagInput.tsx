import { Combobox } from '@base-ui/react/combobox';
import { Check, CircleAlert, X } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { chip, flatField, ghost, key, raised, sunk } from '../theme/stone.ts';

const widths = { sm: 'w-32', md: 'w-80 max-w-full', full: 'w-full' };

export type TagOption = string | { value: string; label?: string; disabled?: boolean };

type TagInputProps = {
  label: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  // The tags that a person can select. A typed text that is not in the list becomes a tag of its own.
  options?: TagOption[];
  placeholder?: string;
  description?: string;
  error?: string;
  // The text of the dropdown when no option matches.
  emptyText?: string;
  disabled?: boolean;
  width?: keyof typeof widths;
};

const normalize = (options: TagOption[]) => options.map((option) => (typeof option === 'string' ? { value: option } : option));

// An input with tags. A tag has a cross that removes it. The list of options filters as the person types, and Enter
// adds the highlighted option, the one that matches the text, or the text itself as a new tag.
export function TagInput({ label, value, onValueChange, options = [], placeholder, description, error, emptyText = 'No options.', disabled, width = 'md' }: TagInputProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const all = useMemo(() => {
    const list = normalize(options);
    for (const selected of value) if (!list.some((option) => option.value === selected)) list.push({ value: selected });
    return list;
  }, [options, value]);

  const labels = useMemo(() => new Map(all.map((option) => [option.value, option.label ?? option.value])), [all]);
  const items = all.map((option) => option.value);
  const textOf = (item: string) => labels.get(item) ?? item;

  const add = (next: string) => {
    if (!value.includes(next)) onValueChange([...value, next]);
    setInputValue('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !inputValue.trim()) return;
    // Base UI takes Enter while an option is highlighted.
    if (highlighted !== null) return;
    event.preventDefault();
    const typed = inputValue.trim();
    const match = all.find((option) => option.value === typed || (option.label ?? option.value).toLowerCase() === typed.toLowerCase());
    add(match?.value ?? typed);
  };

  return (
    <div className={`grid gap-2 ${widths[width]}`}>
      <label htmlFor={id} className="text-ink text-[13px]/none font-[550]">
        {label}
      </label>
      <Combobox.Root
        multiple
        items={items}
        value={value}
        open={open}
        onOpenChange={setOpen}
        onValueChange={(next) => onValueChange(next)}
        inputValue={inputValue}
        onInputValueChange={(next, eventDetails) => {
          setInputValue(next);
          // Only a typed change opens the list. The clear after a selection or a close must not reopen it.
          if (eventDetails.reason === 'input-change') setOpen(true);
        }}
        onItemHighlighted={(item) => setHighlighted(item ?? null)}
        itemToStringLabel={textOf}
        disabled={disabled}
      >
        <Combobox.Chips
          ref={anchorRef}
          className={`${flatField} flex flex-wrap items-center gap-1.5 px-2 py-1.5 text-[15px]`}
          data-invalid={error ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
        >
          <Combobox.Value>
            {(selected: string[]) => (
              <>
                {selected.map((item) => (
                  <Combobox.Chip key={item} className={chip}>
                    {textOf(item)}
                    <button
                      type="button"
                      aria-label={`Remove ${textOf(item)}`}
                      disabled={disabled}
                      onClick={() => onValueChange(value.filter((selected) => selected !== item))}
                      className={`${key} ${ghost} flex items-center justify-center size-5 rounded-sm cursor-pointer disabled:cursor-not-allowed [&>svg]:size-3.5`}
                    >
                      <X />
                    </button>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  id={id}
                  placeholder={selected.length ? undefined : placeholder}
                  aria-describedby={[description ? descriptionId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined}
                  aria-invalid={Boolean(error)}
                  onFocus={() => setOpen(true)}
                  onClick={() => setOpen(true)}
                  onKeyDown={onKeyDown}
                  className="min-w-24 flex-1 h-7 bg-transparent text-[15px]/none text-ink-strong outline-none placeholder:text-fog placeholder:opacity-60 disabled:cursor-not-allowed"
                />
              </>
            )}
          </Combobox.Value>
        </Combobox.Chips>
        <Combobox.Portal>
          <Combobox.Positioner anchor={anchorRef} align="start" sideOffset={8}>
            <Combobox.Popup className="box-border min-w-(--anchor-width) max-h-[min(15rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 rounded-lg outline-none bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink">
              <Combobox.List>
                {(item: string) => {
                  const option = all.find((candidate) => candidate.value === item);
                  return (
                    <Combobox.Item
                      key={item}
                      value={item}
                      disabled={option?.disabled}
                      className={({ selected }) => `${key} ${selected ? sunk : ghost} group flex items-center justify-between gap-6 w-full h-10 px-3 rounded-[5px] cursor-pointer data-disabled:opacity-35 data-disabled:cursor-not-allowed`}
                    >
                      <span>{textOf(item)}</span>
                      <Combobox.ItemIndicator keepMounted className="flex text-accent invisible group-data-selected:visible [&>svg]:size-4">
                        <Check />
                      </Combobox.ItemIndicator>
                    </Combobox.Item>
                  );
                }}
              </Combobox.List>
              <Combobox.Empty className="px-3 py-2 text-fog text-[13px]/4 empty:hidden">{emptyText}</Combobox.Empty>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {description && (
        <p id={descriptionId} className="text-fog text-[13px]/4">
          {description}
        </p>
      )}
      <div className="grid min-h-3.5">
        {error && (
          <p id={errorId} className="flex items-center gap-1.5 min-h-4 -mt-0.5 text-error text-[13px]/4 font-medium">
            <CircleAlert className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

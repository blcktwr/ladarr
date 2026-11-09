import { Input } from '@base-ui/react/input';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { flat } from '../theme/stone.ts';

type SearchFieldProps = {
  'aria-label': string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  // A button at the end of the field, such as the one that opens a panel of search options.
  trailing?: ReactNode;
};

// A search field is a field with a lens at its start. Enter submits it, and the browser's own button clears it.
export function SearchField({ 'aria-label': label, value, onChange, onSubmit, placeholder, trailing }: SearchFieldProps) {
  return (
    <form
      role="search"
      className="relative flex items-center"
      onSubmit={event => { event.preventDefault(); onSubmit?.(value); }}
    >
      <span className="absolute left-3.5 flex text-fog pointer-events-none [&>svg]:size-4.5"><Search /></span>
      <Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onValueChange={onChange}
        className={`${flat} w-full pl-11 ${trailing ? 'pr-12' : 'pr-4'} text-[17px]/none [&::-webkit-search-cancel-button]:[-webkit-appearance:none] [&::-webkit-search-cancel-button]:size-3.5 [&::-webkit-search-cancel-button]:bg-fog [&::-webkit-search-cancel-button]:[mask:var(--icon-close)_center/contain_no-repeat] [&::-webkit-search-cancel-button]:cursor-pointer`}
      />
      {trailing && <span className="absolute right-1.5 flex">{trailing}</span>}
    </form>
  );
}

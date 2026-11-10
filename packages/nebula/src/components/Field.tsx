import { Field as BaseField } from '@base-ui/react/field';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { flat, flatSmall } from '../theme/stone.ts';

const widths = { xs: 'w-12', sm: 'w-32', md: 'w-80 max-w-full', full: 'w-full' };

// md is the normal field of a form. sm is a small field for a value in a row of a table or a dense form.
const sizes = {
  md: { surface: flat, pad: 'px-3.5', text: 'text-[15px]/none', gap: 'gap-2', reserve: true },
  sm: { surface: flatSmall, pad: 'px-2', text: 'text-[12px]/none', gap: 'gap-1.5', reserve: false },
} as const;

type FieldProps = Omit<BaseField.Control.Props, 'className' | 'size'> & {
  label: string;
  // The label is for a screen reader only, such as the label of a key that you can only read.
  hideLabel?: boolean;
  description?: string;
  error?: string;
  width?: keyof typeof widths;
  size?: keyof typeof sizes;
  // The field is off, and a line strikes it out.
  deactivated?: boolean;
  // A control at the right of the input, in its row, such as a Button. The width is the width of the input and the action together.
  action?: ReactNode;
  // A short text inside the field, after the input, such as a unit: ms or s.
  suffix?: string;
};

// An input with a label above it. A required input has a mark after its label. The description and the error show under it.
// An error makes the field invalid. The last row keeps the error's place when there is no error, so the form does not jump.
// A small field has no place for the error when there is none, so it stays compact in a row.
export function Field({ label, hideLabel, description, error, width = 'md', size = 'md', deactivated, action, suffix, ...props }: FieldProps) {
  const disabled = props.disabled || deactivated;
  const look = sizes[size];
  // A small field sits in a row of values, so the arrows of a number input do not match the stone.
  const spin = size === 'sm' ? '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none' : '';
  const control = <BaseField.Control {...props} disabled={disabled} data-deactivated={deactivated || undefined} className={suffix ? `w-full min-w-0 bg-transparent ${look.text} ${spin} outline-none placeholder:text-fog placeholder:opacity-60 disabled:cursor-not-allowed` : `${look.surface} w-full min-w-0 ${look.pad} ${look.text} ${spin}`} />;
  const field = suffix ? (
    <div data-invalid={error ? '' : undefined} data-disabled={disabled ? '' : undefined} data-deactivated={deactivated || undefined} className={`${look.surface} flex items-center gap-2 w-full min-w-0 ${look.pad} focus-within:inset-ring-3 focus-within:inset-ring-accent`}>
      {control}
      <span className="shrink-0 text-fog text-[13px]/none">{suffix}</span>
    </div>
  ) : control;
  const message = (
    <BaseField.Error match={Boolean(error)} className="flex items-center gap-1.5 min-h-4 -mt-0.5 text-error text-[13px]/4 font-medium [&>svg]:size-3.5 [&>svg]:shrink-0">
      {/* The icon tells the error apart without its colour. */}
      <CircleAlert />{error}
    </BaseField.Error>
  );
  return (
    <BaseField.Root invalid={Boolean(error)} className={`grid ${look.gap} ${widths[width]}`}>
      <BaseField.Label className={hideLabel ? 'sr-only' : 'text-ink text-[13px]/none font-[550]'}>
        {label}{props.required && !hideLabel && <span aria-hidden="true" className="ml-1 text-fog">*</span>}
      </BaseField.Label>
      {action ? <div className="flex items-center gap-3">{field}{action}</div> : field}
      {description && <BaseField.Description className="text-fog text-[13px]/4">{description}</BaseField.Description>}
      {look.reserve ? <div className="grid min-h-3.5">{message}</div> : error && message}
    </BaseField.Root>
  );
}

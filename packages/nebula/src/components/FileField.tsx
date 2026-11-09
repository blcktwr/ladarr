import { CircleAlert, Upload } from 'lucide-react';
import { useId } from 'react';
import { flat } from '../theme/stone.ts';

const widths = { sm: 'w-32', md: 'w-80 max-w-full', full: 'w-full' };

type FileFieldProps = {
  label: string;
  // The text inside the field while no file is chosen.
  placeholder?: string;
  // The name of the chosen file. The parent sets it after it reads the file.
  value?: string;
  accept?: string;
  disabled?: boolean;
  description?: string;
  error?: string;
  width?: keyof typeof widths;
  onFile: (file: File) => void;
};

// A field that takes a file from the device. It is flat, and its text is in the middle of its height.
// A click anywhere on the field opens the picker of the system. The input fills the field, so the keys work as well.
export function FileField({ label, placeholder = 'Choose file', value, accept, disabled, description, error, width = 'md', onFile }: FileFieldProps) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  return (
    <div className={`grid gap-2 ${widths[width]}`}>
      <label htmlFor={id} className="text-ink text-[13px]/none font-[550]">
        {label}
      </label>
      <div
        className={`${flat} bg-field! relative flex items-center focus-within:inset-ring-3 focus-within:inset-ring-accent`}
        data-invalid={error ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
      >
        <span className={`flex items-center justify-center gap-2 w-full min-w-0 px-3.5 text-[15px]/none ${value ? 'text-ink-strong' : 'text-fog opacity-60'}`}>
          <Upload className="size-4 shrink-0" />
          <span className="truncate min-w-0">{value || placeholder}</span>
        </span>
        <input
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-describedby={[description ? descriptionId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // The field forgets the old name, so the same file opens the picker again.
            event.currentTarget.value = '';
            if (file) onFile(file);
          }}
          className="absolute inset-0 box-border w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        />
      </div>
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

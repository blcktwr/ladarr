import { CircleAlert, Upload } from 'lucide-react';
import { useId, useState, type DragEvent } from 'react';
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
export function FileField({ placeholder = 'Choose file', ...props }: FileFieldProps) {
  return <Field {...props} placeholder={placeholder} />;
}

export function DropFileField({ placeholder = 'Drop or choose a file', ...props }: FileFieldProps) {
  return <Field {...props} placeholder={placeholder} drop />;
}

function accepts(file: File, accept?: string) {
  const types = accept?.toLowerCase().split(',').map((type) => type.trim()).filter(Boolean);
  if (!types?.length) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return types.some((type) => type.startsWith('.') ? name.endsWith(type)
    : type.endsWith('/*') ? mime.startsWith(type.slice(0, -1)) : mime === type);
}

function Field({ label, placeholder, value, accept, disabled, description, error, width = 'md', onFile, drop }: FileFieldProps & { drop?: true }) {
  const id = useId();
  const descriptionId = useId();
  const errorId = useId();
  const [dragging, setDragging] = useState(false);
  function over(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const transfer = event.dataTransfer;
    const active = !disabled && transfer?.types.includes('Files');
    setDragging(Boolean(active));
    if (transfer) transfer.dropEffect = active ? 'copy' : 'none';
  }
  return (
    <div className={`grid gap-2 ${widths[width]}`} {...(drop && {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        const files = event.dataTransfer?.files;
        if (!disabled && files?.length === 1 && accepts(files[0]!, accept)) onFile(files[0]!);
      },
    })}>
      <label htmlFor={id} className="text-ink text-[13px]/none font-[550]">
        {label}
      </label>
      <div
        className={`${flat} bg-field! relative flex items-center focus-within:inset-ring-3 focus-within:inset-ring-accent${drop ? ' data-dragging:bg-field-hover! data-dragging:inset-ring-3 data-dragging:inset-ring-accent' : ''}`}
        data-invalid={error ? '' : undefined}
        data-disabled={disabled ? '' : undefined}
        data-dragging={drop && dragging && !disabled ? '' : undefined}
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
            const files = event.currentTarget.files;
            const file = !drop || files?.length === 1 ? files?.[0] : undefined;
            // The field forgets the old name, so the same file opens the picker again.
            event.currentTarget.value = '';
            if (file && (!drop || (!disabled && accepts(file, accept)))) onFile(file);
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

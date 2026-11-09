import { Button as BaseButton } from '@base-ui/react/button';
import { danger, ghost, key, link, linkInherit, plain, raised, wheel } from '../theme/stone.ts';

// The red text of ghost-danger stays in each state, so it overrides the colors of ghost, as in ActionMenu.
const looks = { primary: raised, ghost, danger, 'ghost-danger': `${ghost} text-error!`, link, 'link-inherit': linkInherit, plain };

type ButtonProps = Omit<BaseButton.Props, 'className'> & {
  variant?: keyof typeof looks;
  iconOnly?: boolean;
  // The button waits for a result. It shows a wheel and it is off, but it is not struck out.
  pending?: boolean;
  // The button loads, for an action that processes. Another name for pending.
  loading?: boolean;
  // The button is off, and a line strikes it out.
  deactivated?: boolean;
  className?: string;
};

// variant is primary (the default), ghost, danger, ghost-danger, link, link-inherit or plain. Danger is for an action that destroys data. ghost-danger is a ghost key with red text, for the same kind of action. link is a simple link: the label in the accent, with a line only when the pointer is on it. link-inherit takes the color of the text around it, for a link on a colored surface. plain is a label with no block, no line and no bold. A link and a plain label have the size of their label.
// An icon-only button is square and needs an aria-label.
// className is for layout only, such as a margin.
export function Button({ variant = 'primary', iconOnly, pending, loading, deactivated, disabled, children, className = '', ...props }: ButtonProps) {
  const box = variant === 'link' || variant === 'link-inherit' || variant === 'plain' ? '' : `h-11 rounded-md ${iconOnly ? 'w-11' : 'px-4.5'}`;
  const busy = pending || loading;
  return (
    <BaseButton
      {...props}
      disabled={disabled || busy || deactivated}
      data-deactivated={deactivated || undefined}
      aria-busy={busy || undefined}
      className={`${key} ${looks[variant]} inline-flex items-center justify-center gap-2 ${box} cursor-pointer [&>svg]:size-4.5 [&>svg]:shrink-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 ${busy ? 'data-disabled:cursor-progress' : 'data-disabled:opacity-65 data-disabled:cursor-not-allowed'} data-deactivated:struck ${className}`}
    >
      {busy && <span aria-hidden="true" className={`${wheel} size-4`} />}
      {children}
    </BaseButton>
  );
}

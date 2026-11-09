import { alert } from 'nebula';
import { Children, useEffect, type ReactNode } from 'react';

type AlertProps = { tone: 'success' | 'warning' | 'danger'; title?: string; children?: ReactNode };

// Nebula shows an alert as a toast. This alert shows while the component is on the page, and it closes when the component goes.
// A success goes away by itself. A warning or a danger stays, because the person must read it.
export function Alert({ tone, title, children }: AlertProps) {
  // The alert shows again when the words change.
  const text = Children.toArray(children).filter((child) => typeof child === 'string' || typeof child === 'number').join('');
  useEffect(() => {
    // The text is the description, and the title is optional.
    const options = { timeout: tone === 'success' ? undefined : 0 };
    const heading = title ?? '';
    const id =
      tone === 'success' ? alert.success(heading, text, options) : tone === 'warning' ? alert.warn(heading, text, options) : alert.danger(heading, text, options);
    return () => alert.close(id);
  }, [tone, title, text]);
  return null;
}

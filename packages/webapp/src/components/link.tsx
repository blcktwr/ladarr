import { Button } from 'nebula';
import type { ReactNode } from 'react';
import { useHref, useNavigate } from 'react-router';

// Nebula has no link. This is a ghost Button that renders an anchor, so a new tab opens the right page.
export function Link({ href, children }: { href: string; children?: ReactNode }) {
  const navigate = useNavigate();
  const target = useHref(href);
  return (
    <Button
      variant="ghost"
      nativeButton={false}
      role="link"
      render={<a href={target} />}
      onClick={(event) => {
        // A click with a key held down keeps its meaning, such as a new tab.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void navigate(href);
      }}
    >
      {children}
    </Button>
  );
}

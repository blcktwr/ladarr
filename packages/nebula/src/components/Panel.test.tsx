import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Panel } from '../index.ts';

const widthOf = (name: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${name}"]`)!.style.width;

describe('Panel stack', () => {
  it('keeps the width of its size when no panel is under it', () => {
    render(
      <Panel open onOpenChange={() => undefined} label="First" size="xl">
        <p>Body</p>
      </Panel>,
    );

    expect(widthOf('First')).toBe('50%');
  });

  it('takes 95% of the width of the panel under it', () => {
    render(
      <Panel open onOpenChange={() => undefined} label="First" size="xl">
        <Panel open onOpenChange={() => undefined} label="Second" size="md">
          <Panel open onOpenChange={() => undefined} label="Third" size="md">
            <p>Body</p>
          </Panel>
        </Panel>
      </Panel>,
    );

    expect(widthOf('First')).toBe('50%');
    expect(widthOf('Second')).toBe('calc(47.5%)');
    expect(widthOf('Third')).toBe('calc(45.125%)');
  });

  it('shows the title in the row of the close button', () => {
    render(
      <Panel open onOpenChange={() => undefined} label="Logs" title="Logs of Firefly">
        <p>Body</p>
      </Panel>,
    );

    const title = screen.getByRole('heading', { name: 'Logs of Firefly' });
    expect(title.parentElement).toBe(screen.getByLabelText('Close').parentElement);
  });
});

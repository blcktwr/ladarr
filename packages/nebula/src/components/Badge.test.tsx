import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Badge } from '../index.ts';

describe('Badge', () => {
  it('is a label with no button when it has no click', () => {
    render(<Badge>2160p</Badge>);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('2160p')).toBeTruthy();
  });

  it('is a button with its label and takes a click when it has one', () => {
    const onClick = vi.fn();
    render(
      <Badge onClick={onClick} label="Show details of 2160p">
        2160p
      </Badge>,
    );

    const button = screen.getByRole('button', { name: 'Show details of 2160p' });

    button.click();

    expect(onClick).toHaveBeenCalledOnce();
  });
});

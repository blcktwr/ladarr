import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Divider } from '../index.ts';

describe('Divider', () => {
  it('renders a horizontal separator', () => {
    render(<Divider />);

    const divider = screen.getByRole('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
  });
});

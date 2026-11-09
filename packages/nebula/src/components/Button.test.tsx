import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../index.ts';

describe('Button', () => {
  it('is off and busy while it loads', () => {
    render(<Button loading>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('is off and busy while it is pending', () => {
    render(<Button pending>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('is on and not busy without loading or pending', () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });

    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-busy')).toBeNull();
  });
});

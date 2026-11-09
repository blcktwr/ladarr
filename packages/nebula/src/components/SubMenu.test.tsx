import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubMenu } from '../index.ts';

describe('SubMenu', () => {
  it('keeps the width of the count when the number changes length', () => {
    render(
      <SubMenu
        aria-label="Sections"
        items={[
          { value: 'one', label: 'One', count: 1 },
          { value: 'many', label: 'Many', count: 100 },
        ]}
      />,
    );

    expect(screen.getByText('1').style.width).toBe('2rem');
    expect(screen.getByText('100').style.width).toBe('2rem');
  });
});

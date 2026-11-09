import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Details } from '../index.ts';

const ITEMS = [
  { label: 'Address', value: '1 Main Street' },
  { label: 'Port', value: '8080' },
];

describe('Details', () => {
  it('renders every label in a dt and every value in a dd', () => {
    render(<Details items={ITEMS} />);

    for (const item of ITEMS) {
      expect(screen.getByText(item.label).tagName).toBe('DT');
      expect(screen.getByText(item.value).tagName).toBe('DD');
    }
  });

  it('gives a wide item the col-span-full class on its wrapper', () => {
    render(
      <Details
        items={[
          { label: 'Label', value: 'Value' },
          { label: 'Wide label', value: 'Wide value', wide: true },
        ]}
      />,
    );

    const wide = screen.getByText('Wide label').closest('div');
    const normal = screen.getByText('Label').closest('div');

    expect(wide?.classList.contains('col-span-full')).toBe(true);
    expect(normal?.classList.contains('col-span-full')).toBe(false);
  });
});

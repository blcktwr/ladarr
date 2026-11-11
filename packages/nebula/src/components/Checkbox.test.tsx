import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Checkbox } from '../index.ts';

function Example() {
  const [on, setOn] = useState(false);
  return <Checkbox label="Enabled" checked={on} onCheckedChange={setOn} />;
}

describe('Checkbox', () => {
  it('changes when the label is clicked', () => {
    render(<Example />);

    screen.getByText('Enabled').click();

    expect(screen.getByRole('checkbox', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('true');
  });
});

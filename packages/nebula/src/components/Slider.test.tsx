import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Slider } from '../index.ts';

function Example() {
  const [value, setValue] = useState(25);
  return <Slider label="Amount" value={value} onValueChange={setValue} />;
}

function RangeExample() {
  const [value, setValue] = useState<number[]>([15, 60, 150]);
  return (
    <Slider
      label={['Minimum', 'Preferred', 'Maximum']}
      value={value}
      onValueChange={setValue}
      formatValue={(amount) => String(amount)}
    />
  );
}

describe('Slider', () => {
  it('changes when an arrow key is pressed', () => {
    render(<Example />);

    // jsdom does not measure the track, so the thumb wrapper stays hidden and getByRole skips the input.
    const labeled = screen.queryByLabelText('Amount');
    const slider = labeled ?? document.querySelector('input[type="range"]');

    if (!slider) {
      throw new Error('The slider input is not in the document');
    }

    if (!labeled) {
      expect(slider.getAttribute('aria-label')).toBe('Amount');
    }

    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    expect(slider.getAttribute('aria-valuenow')).toBe('26');
  });

  it('renders one input for each value with its label and formatted value', () => {
    render(<RangeExample />);

    screen.getByLabelText('Minimum');
    screen.getByLabelText('Preferred');
    screen.getByLabelText('Maximum');

    expect(screen.queryByText('15')).not.toBeNull();
    expect(screen.queryByText('60')).not.toBeNull();
    expect(screen.queryByText('150')).not.toBeNull();
  });

  it('changes one thumb when an arrow key is pressed', () => {
    render(<RangeExample />);

    const preferred = screen.getByLabelText('Preferred');

    fireEvent.keyDown(preferred, { key: 'ArrowRight' });

    expect(preferred.getAttribute('aria-valuenow')).toBe('61');
  });
});

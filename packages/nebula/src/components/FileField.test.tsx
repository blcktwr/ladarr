import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileField } from '../index.ts';

describe('FileField', () => {
  it('shows the placeholder, and the name of the file in its place', () => {
    const { rerender } = render(<FileField label="Backup" placeholder="Choose a file" onFile={() => {}} />);
    expect(screen.getByText('Choose a file')).toBeTruthy();

    rerender(<FileField label="Backup" placeholder="Choose a file" value="backup.zip" onFile={() => {}} />);
    expect(screen.getByText('backup.zip')).toBeTruthy();
    expect(screen.queryByText('Choose a file')).toBeNull();
  });

  it('gives the chosen file, with the label as the accessible name', () => {
    const onFile = vi.fn();
    render(<FileField label="Backup" onFile={onFile} />);
    const file = new File(['zip'], 'backup.zip', { type: 'application/zip' });

    fireEvent.change(screen.getByLabelText('Backup'), { target: { files: [file] } });

    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('renders the description and the error', () => {
    render(<FileField label="Backup" description="A ZIP file." error="The file is damaged." onFile={() => {}} />);

    expect(screen.getByText('A ZIP file.')).toBeTruthy();
    expect(screen.getByText('The file is damaged.')).toBeTruthy();
    expect(screen.getByLabelText('Backup').getAttribute('aria-invalid')).toBe('true');
  });
});

import { act } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alert, Alerts, Modal, Panel, useAlerts } from '../index.ts';

const TONE_ICONS = [
  'lucide-circle-check',
  'lucide-triangle-alert',
  'lucide-circle-alert',
  'lucide-octagon-alert',
] as const;

function renderAlerts() {
  return render(
    <Alerts>
      <div />
    </Alerts>,
  );
}

function addNow(create: () => string): string {
  let id = '';
  act(() => {
    id = create();
  });
  return id;
}

function closeNow(id?: string) {
  act(() => {
    alert.close(id);
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function closeButton() {
  return screen.queryByLabelText('Close');
}

function visibleToneIcons() {
  return TONE_ICONS.filter((name) => document.querySelector(`.${name}`) !== null);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Alerts imperative API', () => {
  it('renders nothing before an alert is added', () => {
    const { container } = renderAlerts();

    expect(container.textContent).toBe('');
    expect(closeButton()).toBeNull();
  });

  it('shows a neutral alert with a title, a description, and a close button', () => {
    renderAlerts();

    const id = addNow(() => alert.show('Title', 'Message'));

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Message')).toBeTruthy();
    expect(closeButton()).not.toBeNull();
  });

  it('renders the success tone icon and text', () => {
    renderAlerts();

    const id = addNow(() => alert.success('Success title', 'Success message'));

    expect(typeof id).toBe('string');
    expect(screen.getByText('Success title')).toBeTruthy();
    expect(screen.getByText('Success message')).toBeTruthy();
    expect(visibleToneIcons()).toEqual(['lucide-circle-check']);
  });

  it('renders the warn tone icon and text', () => {
    renderAlerts();

    const id = addNow(() => alert.warn('Warn title', 'Warn message'));

    expect(typeof id).toBe('string');
    expect(screen.getAllByText('Warn title').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Warn message').length).toBeGreaterThan(0);
    expect(visibleToneIcons()).toEqual(['lucide-triangle-alert']);
  });

  it('renders the danger tone icon and text', () => {
    renderAlerts();

    const id = addNow(() => alert.danger('Danger title', 'Danger message'));

    expect(typeof id).toBe('string');
    expect(screen.getAllByText('Danger title').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Danger message').length).toBeGreaterThan(0);
    expect(visibleToneIcons()).toEqual(['lucide-circle-alert']);
  });

  it('renders the blocker tone icon and text', () => {
    renderAlerts();

    const id = addNow(() => alert.blocker('Blocker title', 'Blocker message'));

    expect(typeof id).toBe('string');
    expect(screen.getAllByText('Blocker title').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Blocker message').length).toBeGreaterThan(0);
    expect(visibleToneIcons()).toEqual(['lucide-octagon-alert']);
  });

  it('renders no tone icon for show', () => {
    renderAlerts();

    addNow(() => alert.show('Neutral title', 'Neutral message'));

    expect(screen.getByText('Neutral title')).toBeTruthy();
    expect(visibleToneIcons()).toEqual([]);
  });

  it('shows the close button by default and hides it with close false', () => {
    renderAlerts();

    const firstId = addNow(() => alert.show('With close', 'Default'));
    expect(closeButton()).not.toBeNull();

    closeNow(firstId);
    expect(screen.queryByText('With close')).toBeNull();

    addNow(() => alert.show('Without close', 'Option', { close: false }));
    expect(screen.getByText('Without close')).toBeTruthy();
    expect(closeButton()).toBeNull();
  });

  it('closes the alert with the returned id', () => {
    renderAlerts();

    addNow(() => alert.show('First', 'One'));
    const secondId = addNow(() => alert.show('Second', 'Two'));

    expect(screen.getByText('Second')).toBeTruthy();

    closeNow(secondId);

    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('First')).toBeTruthy();
  });

  it('closes all alerts when close is called without an id', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.show('First', 'One'));
    addNow(() => alert.show('Second', 'Two'));

    closeNow();

    expect(screen.queryByText('First')).toBeNull();

    await advance(10000);

    expect(screen.queryByText('First')).toBeNull();
    expect(screen.queryByText('Second')).toBeNull();
    expect(closeButton()).toBeNull();
  });

  it('auto-dismisses the front alert after 5000 ms and promotes the next alert', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.show('First', 'One'));
    addNow(() => alert.show('Second', 'Two'));

    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();

    await advance(4999);
    expect(screen.getByText('Second')).toBeTruthy();

    await advance(1);
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('First')).toBeTruthy();

    await advance(4999);
    expect(screen.getByText('First')).toBeTruthy();

    await advance(1);
    expect(screen.queryByText('First')).toBeNull();
  });

  it('starts the time of an alert again when it comes back to the front', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.show('First', 'One', { timeout: 1000 }));
    await advance(600);
    expect(screen.getByText('First')).toBeTruthy();

    addNow(() => alert.show('Second', 'Two', { timeout: 2000 }));
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();

    await advance(2000);
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByText('First')).toBeTruthy();

    await advance(999);
    expect(screen.getByText('First')).toBeTruthy();

    await advance(1);
    expect(screen.queryByText('First')).toBeNull();
  });

  it('uses the custom timeout option', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.show('Custom timeout', 'Message', { timeout: 1000 }));

    await advance(999);
    expect(screen.getByText('Custom timeout')).toBeTruthy();

    await advance(1);
    expect(screen.queryByText('Custom timeout')).toBeNull();
  });

  it('keeps an alert with timeout 0', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.show('Persistent', 'Message', { timeout: 0 }));

    await advance(15000);

    expect(screen.getByText('Persistent')).toBeTruthy();
    expect(closeButton()).not.toBeNull();
  });

  it('uses the Alerts timeout prop as the default', async () => {
    vi.useFakeTimers();
    render(
      <Alerts timeout={1000}>
        <div />
      </Alerts>,
    );

    addNow(() => alert.show('Prop timeout', 'Message'));

    await advance(999);
    expect(screen.getByText('Prop timeout')).toBeTruthy();

    await advance(1);
    expect(screen.queryByText('Prop timeout')).toBeNull();
  });

  it('renders only the newest alert until it leaves', () => {
    renderAlerts();

    addNow(() => alert.show('Oldest', 'First message'));
    const newestId = addNow(() => alert.show('Newest', 'Second message'));

    expect(screen.getByText('Newest')).toBeTruthy();
    expect(screen.queryByText('Oldest')).toBeNull();
    expect(screen.queryByText('First message')).toBeNull();

    closeNow(newestId);

    expect(screen.queryByText('Newest')).toBeNull();
    expect(screen.getByText('Oldest')).toBeTruthy();
  });

  it('keeps a blocker visible without a close button past the default timeout', async () => {
    vi.useFakeTimers();
    renderAlerts();

    addNow(() => alert.blocker('Blocked', 'Do it'));

    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(closeButton()).toBeNull();

    await advance(15000);

    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(closeButton()).toBeNull();
  });

  it('renders the action and calls its onClick', () => {
    renderAlerts();
    const onClick = vi.fn();

    addNow(() =>
      alert.show('Action alert', 'Message', {
        action: { label: 'Undo', onClick },
      }),
    );

    const action = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(action);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still renders alerts added with useAlerts().add', () => {
    let addFromHook: ReturnType<typeof useAlerts>['add'] | undefined;

    function Probe() {
      const { add } = useAlerts();
      addFromHook = add;
      return null;
    }

    render(
      <Alerts>
        <Probe />
      </Alerts>,
    );

    expect(addFromHook).toBeDefined();

    act(() => {
      addFromHook?.({ title: 'Hook title', description: 'Hook message' });
    });

    expect(screen.getByText('Hook title')).toBeTruthy();
    expect(screen.getByText('Hook message')).toBeTruthy();
  });

  it('hides every alert while a modal is open, and shows them again when it closes', () => {
    const { rerender } = render(
      <Alerts>
        <Modal open={false} onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );
    const id = addNow(() => alert.show('Hidden title', 'Message'));

    expect(screen.getByText('Hidden title').closest('.invisible')).toBeNull();

    rerender(
      <Alerts>
        <Modal open onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );
    expect(screen.getByText('Hidden title').closest('.invisible')).not.toBeNull();
    expect(screen.getByText('Hidden title').closest('[aria-hidden="true"]')).not.toBeNull();

    rerender(
      <Alerts>
        <Modal open={false} onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );
    expect(screen.getByText('Hidden title').closest('.invisible')).toBeNull();

    closeNow(id);
  });

  it('hides every alert while a panel is open', () => {
    const { rerender } = render(
      <Alerts>
        <Panel open={false} onOpenChange={() => undefined} label="Test panel"><p>Body</p></Panel>
      </Alerts>,
    );
    const id = addNow(() => alert.show('Under the panel', 'Message'));

    expect(screen.getByText('Under the panel').closest('.invisible')).toBeNull();

    rerender(
      <Alerts>
        <Panel open onOpenChange={() => undefined} label="Test panel"><p>Body</p></Panel>
      </Alerts>,
    );
    expect(screen.getByText('Under the panel').closest('.invisible')).not.toBeNull();

    rerender(
      <Alerts>
        <Panel open={false} onOpenChange={() => undefined} label="Test panel"><p>Body</p></Panel>
      </Alerts>,
    );
    expect(screen.getByText('Under the panel').closest('.invisible')).toBeNull();

    closeNow(id);
  });

  it('keeps the time of an alert while a modal is open', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Alerts>
        <Modal open={false} onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );
    const id = addNow(() => alert.show('Waiting title', 'Message', { timeout: 1000 }));

    await advance(600);
    rerender(
      <Alerts>
        <Modal open onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );
    await advance(5000);
    rerender(
      <Alerts>
        <Modal open={false} onOpenChange={() => undefined} title="Test modal"><p>Body</p></Modal>
      </Alerts>,
    );

    expect(screen.getByText('Waiting title').closest('.invisible')).toBeNull();
    await advance(900);
    expect(screen.queryByText('Waiting title')).not.toBeNull();
    await advance(200);
    expect(screen.queryByText('Waiting title')).toBeNull();

    closeNow(id);
  });
});

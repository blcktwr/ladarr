import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, OctagonAlert, TriangleAlert, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from './Button.tsx';

// Each tone has its own icon, so a person can find the tone without the color. The fill is the stone of the tone, with the relief of a key.
// A blocker is a warning alert that the person cannot close. It stays until the condition that made it ends.
const tones = {
  success: { Icon: CircleCheck, fill: 'bg-(image:--success) shadow-(--success-edge) text-ink-light' },
  warning: { Icon: TriangleAlert, fill: 'bg-(image:--warning) shadow-(--warning-edge) text-ink-dark' },
  danger: { Icon: CircleAlert, fill: 'bg-(image:--danger) shadow-(--danger-edge) text-ink-light' },
  blocker: { Icon: OctagonAlert, fill: 'bg-(image:--warning) shadow-(--warning-edge) text-ink-dark' },
};

type AlertToast = ReturnType<typeof Toast.useToastManager>['toasts'][number];

// The time that the author asked for. The front alert uses it; the alerts behind it wait with a time of 0.
// close is false for an alert that has no close button, such as a blocker.
type AlertData = { alertTimeout?: number; alertClose?: boolean };

// The default time of an alert. useAlerts reads it, so that a new alert keeps the time that it asked for while it waits.
const AlertTimeoutContext = createContext(5000);

// The one manager of the app. alert uses it from any TypeScript file, and Alerts gives it to the provider.
const manager = Toast.createToastManager();

// The number of overlays that are open: a modal, a confirm or a panel. Every alert waits under them.
let openModals = 0;
const modalListeners = new Set<() => void>();
const announceModal = () => modalListeners.forEach((listener) => listener());

// A modal, a confirm or a panel registers while it is open.
export function useModalRegistration(open: boolean) {
  useEffect(() => {
    if (!open) return;
    openModals++;
    announceModal();
    return () => {
      openModals--;
      announceModal();
    };
  }, [open]);
}

// The pages read it to keep their alerts away from an overlay.
export const useModalOpen = () =>
  useSyncExternalStore(
    (listener) => (modalListeners.add(listener), () => void modalListeners.delete(listener)),
    () => openModals > 0,
  );

export type AlertOptions = {
  // An id lets a later alert replace this one, or close it.
  id?: string;
  // false hides the close button. A blocker has no close button in all cases.
  close?: boolean;
  // Milliseconds before the alert leaves on its own. 0 keeps it. The default is the timeout of Alerts.
  timeout?: number;
  action?: { label: string; onClick: () => void };
};

type AlertTone = 'success' | 'warning' | 'danger' | 'blocker';

// The alerts wait with a time of 0, so that each one starts its own time when it comes to the front. The queue reads the time and the close button from the data.
function addAlert(type: AlertTone | undefined, title: string, description: string | undefined, options: AlertOptions = {}) {
  const blocker = type === 'blocker';
  return manager.add({
    id: options.id,
    type,
    title,
    description,
    priority: type === 'warning' || type === 'danger' || blocker ? 'high' : 'low',
    timeout: 0,
    data: {
      alertTimeout: blocker ? 0 : options.timeout,
      alertClose: blocker ? false : options.close ?? true,
    },
    actionProps: options.action && { children: options.action.label, onClick: options.action.onClick },
  });
}

// Add an alert from any TypeScript file, with no component. Alerts must be mounted once around the app.
export const alert = {
  show: (title: string, description?: string, options?: AlertOptions) => addAlert(undefined, title, description, options),
  success: (title: string, description?: string, options?: AlertOptions) => addAlert('success', title, description, options),
  warn: (title: string, description?: string, options?: AlertOptions) => addAlert('warning', title, description, options),
  danger: (title: string, description?: string, options?: AlertOptions) => addAlert('danger', title, description, options),
  blocker: (title: string, description?: string, options?: AlertOptions) => addAlert('blocker', title, description, options),
  close: (id?: string) => manager.close(id),
};

// A blocker is a warning alert that the person cannot close. It stays until the condition that made it ends.
const isBlocker = (toast: AlertToast) => toast.type === 'blocker';

// Put it around the app. useAlerts().add puts an alert in a queue at the bottom right of the window.
// It is a queue: the newest alert is in front, and the alerts that wait show as edges above it. Three show at most.
// When the time of the front alert ends, it leaves, and the next alert comes to the front and starts its time.
// A type of success, warning, danger or blocker makes it a block of the stone of its tone, with its icon. Without a type, it is a slab.
// It goes away after 5 seconds, or when you click its close button. A timeout of 0 keeps the front alert, and the queue waits.
// While the pointer or the focus is on it, the time stops.
// A blocker is in the queue too, and it never leaves on its own.
// A modal, a confirm or a panel covers the window. Every alert waits under it, so the overlay keeps its buttons, and its live region stays quiet.
export function Alerts({ children, limit = 3, timeout = 5000 }: { children: ReactNode; limit?: number; timeout?: number }) {
  const underModal = useModalOpen();
  return (
    <AlertTimeoutContext.Provider value={timeout}>
      {/* The queue does the limit itself, so the store keeps each alert, and each one can start its time when it comes to the front. */}
      <Toast.Provider toastManager={manager} timeout={timeout} limit={Number.MAX_SAFE_INTEGER}>
        {children}
        <Toast.Portal>
          {/* The alerts stay in the store while an overlay is open, so they come back when it closes. The hidden live region reads nothing then. */}
          <div aria-hidden={underModal || undefined} className={underModal ? 'invisible' : undefined}>
            <Toast.Viewport className="fixed z-50 bottom-6 right-6 w-[min(32rem,calc(100vw-3rem))] outline-none pointer-events-none">
              <Queue limit={limit} timeout={timeout} paused={underModal} />
            </Toast.Viewport>
          </div>
        </Toast.Portal>
      </Toast.Provider>
    </AlertTimeoutContext.Provider>
  );
}

function Queue({ limit, timeout, paused }: { limit: number; timeout: number; paused: boolean }) {
  const manager = Toast.useToastManager();
  const active = manager.toasts.filter(toast => toast.transitionStatus !== 'ending');
  // The store puts the newest first: it is the front of the queue.
  const front = active[0];
  // The alerts behind the front, nearest first. A limit of 3 shows the front and two edges above it.
  const edges = Math.max(0, limit - 1);
  const behind = active.slice(1, 1 + edges);
  // Ending alerts that were never in front are invisible, but their roots must stay until the store removes them.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (front) {
      seen.current.add(front.id);
    }
    // Forget the alerts that the store has removed, so the set keeps only the alerts that are on the screen.
    const live = new Set(manager.toasts.map(toast => toast.id));
    seen.current.forEach(id => {
      if (!live.has(id)) {
        seen.current.delete(id);
      }
    });
  }, [front, manager.toasts]);

  // Only the front alert has a time. The others wait with a time of 0, so an alert does not leave before its turn.
  // When an alert comes to the front, or is added again by its id, its own time replaces the time of 0.
  // An overlay stops every time, so the alerts are still there when it closes.
  useEffect(() => {
    if (!front) {
      return;
    }
    for (const toast of active) {
      const data = toast.data as AlertData | undefined;
      const time = paused ? 0 : toast.id === front.id ? data?.alertTimeout ?? timeout : 0;
      if (toast.timeout !== time) {
        manager.update(toast.id, { timeout: time });
      }
    }
  }, [front, active, manager, timeout, paused]);

  const ending = manager.toasts.filter(toast => toast.transitionStatus === 'ending');
  // An ending alert has its place at the front while it fades.
  return (
    <div className="grid gap-2 pointer-events-none">
      <div className="relative pointer-events-none">
        {front && <Alert key={front.id} toast={front} behind={behind} />}
        {ending.map(toast => (
          seen.current.has(toast.id)
            ? front
              ? <Alert key={toast.id} toast={toast} ending />
              : <Alert key={toast.id} toast={toast} />
            : <Toast.Root key={toast.id} toast={toast} className="hidden" />
        ))}
      </div>
    </div>
  );
}

function Alert({ toast, behind = [], ending = false }: { toast: AlertToast; behind?: AlertToast[]; ending?: boolean }) {
  const tone = toast.type && toast.type in tones ? tones[toast.type as keyof typeof tones] : undefined;
  const blocker = isBlocker(toast);
  const data = toast.data as AlertData | undefined;
  const close = data?.alertClose ?? !blocker;
  return (
    <Toast.Root
      toast={toast}
      swipeDirection={blocker ? [] : undefined}
      className={`${ending ? 'absolute inset-x-0 bottom-0 pointer-events-none' : 'relative pointer-events-auto'} isolate w-full rounded-lg outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-3 transition-[opacity,translate] duration-200 ease-stone data-starting-style:opacity-0 data-starting-style:translate-y-4 data-ending-style:opacity-0 data-ending-style:pointer-events-none data-ending-style:translate-y-4 motion-reduce:transition-none`}
    >
      {/* The alerts that wait are edges above the front alert. They take the stone of their tone, so the stack shows what comes. */}
      {behind.map((queued, index) => {
        const queuedTone = queued.type && queued.type in tones ? tones[queued.type as keyof typeof tones] : undefined;
        return (
          <div
            key={queued.id}
            aria-hidden
            className={`absolute inset-0 origin-bottom rounded-lg pointer-events-none transition-transform duration-200 ease-stone motion-reduce:transition-none ${queuedTone ? queuedTone.fill : 'bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink'}`}
            style={{ zIndex: -1 - index, transform: `translateY(${-(index + 1) * 8}px) scale(${1 - (index + 1) * 0.04})` }}
          />
        );
      })}
      <Toast.Content className={`relative z-0 flex items-start gap-3 p-4 rounded-lg text-[15px]/5 ${tone ? tone.fill : 'bg-(image:--grain) bg-slab shadow-(--slab-shadow) text-ink'}`}>
        {tone && <tone.Icon className="size-5 shrink-0" />}
        <div className="grid justify-items-start gap-2 flex-1 min-w-0">
          <Toast.Title className="font-semibold" />
          <Toast.Description />
          <Toast.Action render={<Button variant="link-inherit" />} />
        </div>
        {/* The close button takes the color of the text, so it shows on each tone. It is 32px, centered on the first line. A blocker has no close button. */}
        {close && (
          <Toast.Close aria-label="Close" className="grid place-items-center size-8 -my-1.5 -mr-1.5 shrink-0 rounded-sm outline-none cursor-pointer opacity-70 transition-[opacity,background-color] duration-200 ease-stone hover:opacity-100 hover:bg-dent focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent [&>svg]:size-4.5">
            <X />
          </Toast.Close>
        )}
      </Toast.Content>
    </Toast.Root>
  );
}

// A warning, a danger or a blocker interrupts the screen reader. The alert waits with a time of 0, and the queue starts its time when it comes to the front.
export function useAlerts() {
  const manager = Toast.useToastManager();
  const timeout = useContext(AlertTimeoutContext);
  return {
    ...manager,
    add: (toast: Parameters<typeof manager.add>[0]) => manager.add({
      priority: toast.type === 'warning' || toast.type === 'danger' || toast.type === 'blocker' ? 'high' : 'low',
      ...toast,
      timeout: 0,
      data: { ...toast.data, alertTimeout: toast.type === 'blocker' ? 0 : toast.timeout ?? timeout },
    }),
  };
}

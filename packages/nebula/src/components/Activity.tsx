import { Check, TriangleAlert } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { ghost, tab, wheel } from '../theme/stone.ts';
import { DownloadIcon } from './indicators/DownloadIcon.tsx';

type ActivityProps = {
  // What the queue does, such as running. A wheel turns before the values.
  status: string;
  // The task that runs now.
  task?: string;
  // How many tasks wait, such as 3 in queue.
  queue?: string;
  // The address of a small image of the task, such as a poster. It shows after the state icon, at 2:3.
  thumbnail?: string;
  // The queue cannot continue, such as when a setting is missing: the warning icon, in amber, takes the place of the wheel.
  alert?: boolean;
  // The task is complete: a check takes the place of the wheel and a line strikes out the values from left to right. Then the values move to the right as they fade out.
  done?: boolean;
  // The queue downloads: an arrow that drifts down to a tray takes the place of the wheel.
  download?: boolean;
  // A state of the queue that the component does not know, such as paused. The icon takes the place of the wheel, at 18px, and the class gives the colour of the state.
  state?: { icon: ReactNode; className?: string };
  // href is where the link points, for a new tab. A plain click calls onClick instead, as a navbar tab does.
  href?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

// The state of the queue, at the start of the navbar. It is a navbar tab that opens the page of the activity.
// About one word space between the values, so they read as one sentence. A long task is cut short with an ellipsis.
// The status region is around the link, so a screen reader reads each change and the link stays a plain link.
export function Activity({ status, task, queue, thumbnail, alert, done, download, state, href, onClick }: ActivityProps) {
  return (
    <div role="status" className="flex min-w-0 max-w-full">
      <a
        href={href ?? '#'}
        onClick={event => {
          // A click with a key held down keeps its meaning, such as a new tab.
          if (!onClick || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onClick(event);
        }}
        className={`${tab} ${ghost} min-w-0 max-w-full`}
      >
        {/* A new task makes a new line, so it fades in and does not slide back from the right. It moves less than the padding, so it does not overflow. */}
        <span key={task ?? status} className={`flex items-center gap-2 min-w-0 transition-[translate,opacity] duration-500 ease-stone starting:opacity-0 ${done ? 'translate-x-4 opacity-0 delay-400 motion-reduce:translate-x-0' : ''}`}>
          {done ? <Check className="size-4.5 shrink-0" /> : alert ? <TriangleAlert className="size-4.5 shrink-0 text-warning" /> : download ? <DownloadIcon className="size-4.5 shrink-0" /> : state ? <span className={`flex shrink-0 [&>svg]:size-4.5 ${state.className ?? ''}`}>{state.icon}</span> : <span className={`${wheel} size-4.5`} />}
          {thumbnail && <img src={thumbnail} alt="" className="h-7 aspect-2/3 shrink-0 rounded-[3px] object-cover bg-field" />}
          <span className={`relative flex gap-[.25em] min-w-0 text-[15px] after:absolute after:inset-x-0 after:top-1/2 after:h-[1.5px] after:rounded-full after:bg-current after:origin-left after:transition-transform after:duration-400 after:ease-stone motion-reduce:after:transition-none ${done ? 'after:scale-x-100' : 'after:scale-x-0'}`}>
            {/* The spaces keep the words apart in the name of the link. A flex box does not show them. */}
            <span className="shrink-0">{status}</span>{' '}
            {task && <strong className="min-w-0 truncate [font-weight:inherit]">{task}</strong>}{' '}
            {queue && <span className="shrink-0">{queue}</span>}
          </span>
        </span>
      </a>
    </div>
  );
}

import { Check, FileDown, SearchX, Send, TicketX, TriangleAlert, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { DownloadIcon, Hint, ImportingIcon, PausedIcon, SearchingIcon, Text, ValidatingIcon, WaitingIcon } from 'nebula';
import { t } from '../i18n/index.ts';
import { statusHelpText } from './format.ts';

// The icon of a state. It repeats the word next to it, so a screen reader does not read it. The tone follows the
// state: a wait is in fog, the work in the accent, a pause in amber, and a target that needs the person in the error tone.
const statusIcons: Record<string, ComponentType<{ className?: string }>> = {
  queued: WaitingIcon,
  waiting: SearchingIcon,
  searching: SearchingIcon,
  not_found: SearchX,
  no_match: TicketX,
  stuck: TriangleAlert,
  fetching: FileDown,
  sending: Send,
  downloading: DownloadIcon,
  validating: ValidatingIcon,
  importing: ImportingIcon,
  available: Check,
  paused: PausedIcon,
  cancelled: X,
};
const statusTones: Record<string, string> = {
  queued: 'text-fog',
  waiting: 'text-accent',
  searching: 'text-accent',
  not_found: 'text-warning',
  no_match: 'text-warning',
  stuck: 'text-error',
  fetching: 'text-accent',
  sending: 'text-accent',
  downloading: 'text-accent',
  validating: 'text-accent',
  importing: 'text-accent',
  available: 'text-accent',
  paused: 'text-warning',
  cancelled: 'text-fog',
};

export function StatusIcon({ status }: { status: string }) {
  const Icon = statusIcons[status] ?? SearchingIcon;
  return <Icon className={`size-4.5 shrink-0 ${statusTones[status] ?? 'text-accent'}`} />;
}

// The status of a title: the indicator, the word, and the hint that says what the word means and what the person does
// next. Every indicator has its hint, so a state is never a word with no explanation.
export function StatusText({ status, icon, help = statusHelpText(icon), small }: { status: string; icon: string; help?: string; small?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <StatusIcon status={icon} />
      <Text variant={small ? 'small' : 'body'}>{status}</Text>
      <Hint label={t('About the status {status}', { status })}>{help}</Hint>
    </div>
  );
}

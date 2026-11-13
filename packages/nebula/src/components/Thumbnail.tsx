import { useState } from 'react';
import type { ComponentType, MouseEvent, ReactNode } from 'react';
import { Check } from 'lucide-react';
import emptyThumbnail from '../assets/empty-thumbnail.png';
import { block, bookmark, bookmarkFace, bookmarkShadow } from '../theme/stone.ts';
import { Checkbox } from './Checkbox.tsx';
import { Skeleton } from './Skeleton.tsx';
import { BlockedIcon } from './indicators/BlockedIcon.tsx';
import { DownloadIcon } from './indicators/DownloadIcon.tsx';
import { ImportingIcon } from './indicators/ImportingIcon.tsx';
import { SearchingIcon } from './indicators/SearchingIcon.tsx';
import { ValidatingIcon } from './indicators/ValidatingIcon.tsx';
import { WaitingIcon } from './indicators/WaitingIcon.tsx';

// The width of the poster. xs is for a row of a list, which has its own data next to the poster. md is the size of a list of posters. lg is for a single poster, such as on a Backdrop.
const sizes = { xs: 'w-20', sm: 'w-32', md: 'w-40', lg: 'w-56' };

// The bottom edge of the bookmark rises in the middle, so the tag hangs like a ribbon.
const notch = '[clip-path:polygon(0_0,100%_0,100%_100%,50%_calc(100%_-_0.5rem),0_100%)]';

// The state of a title in the queue, or that it is downloaded. It shows as an icon at the bottom of the bookmark.
export type ThumbnailState = 'waiting' | 'searching' | 'downloading' | 'validating' | 'importing' | 'available' | 'stuck';

const availableIcon = ({ className }: { className?: string }) => <Check className={className} strokeWidth={3} aria-hidden="true" />;

// The icon of each state. It has the size of an indicator, and the colour of the text.
const stateIcons: Record<ThumbnailState, ComponentType<{ className?: string }>> = {
  waiting: WaitingIcon,
  searching: SearchingIcon,
  downloading: DownloadIcon,
  validating: ValidatingIcon,
  importing: ImportingIcon,
  available: availableIcon,
  stuck: BlockedIcon,
};

type Content = {
  // The poster. It is at 2:3, and it fills that box. An empty image shows the bare block.
  image: string;
  // The name of the title or of the person. It shows under the poster, and it stays for a screen reader when the caption shows a status or nothing.
  title: string;
  // A number for a film, or a text for a series, such as 2019–2023.
  year?: number | string;
};

// While loading is on, the content is not necessary.
type ThumbnailProps = (Content | ({ loading: true } & Partial<Content>)) & {
  // The skeleton of the thumbnail while its data loads: a pulse on the block, and a bar for the title and for the year.
  loading?: boolean;
  // The type of content, such as Movies, Series or Anime. It shows as a bookmark at the top left corner of the poster, with its text from top to bottom.
  type?: string;
  // The state of the title, such as Downloading, or available for a title that is downloaded. It shows as an icon at the bottom of the bookmark, under the type.
  state?: ThumbnailState;
  // The name of the state, for a screen reader.
  stateLabel?: string;
  // The state of the title, such as In catalog. It takes the place of the title and the year under the poster, and the title stays for a screen reader.
  status?: string;
  // With noCaption, the poster has no text under it. The title stays for a screen reader.
  noCaption?: boolean;
  // Elements that show over the poster, on a scrim, when the pointer or the focus is on the poster. They are at the bottom center, such as buttons.
  overlay?: ReactNode;
  // With onSelectedChange, a checkbox at the top right corner of the poster selects it. The checkbox shows when the pointer or the focus is on the poster. While it is on, it always shows.
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  size?: keyof typeof sizes;
  // A title that has not been released is dim, so the catalog shows that it has nothing to download yet.
  dimmed?: boolean;
  className?: string;
};

// A poster of a film or a series, with a caption under it and its type on a bookmark at the top left corner. The caption
// shows the title and the year, or a status, or nothing; an empty caption keeps the title for a screen reader.
// The poster is a block of stone. While the image loads, the mark of the app shows on the block under the skeleton. Then the image fades in. Without an image, the mark stays. If the image does not load, the bare block stays.
// The title has one row, and a long title is cut, so the years of a row of posters stay on one line. The pointer on the title shows all of it. The status has one row too.
// className is for layout only, such as a margin.
export function Thumbnail({ image = '', title = '', year = '', loading = false, type, state, stateLabel, status, noCaption = false, overlay, selected = false, onSelectedChange, size = 'md', dimmed = false, className = '' }: ThumbnailProps) {
  // The image that ended its load, so a new image starts with the skeleton.
  const [done, setDone] = useState('');
  const ready = done === image;
  // While it loads, there is nothing to select.
  const selectable = onSelectedChange && !loading;
  // The state has an icon only with the type, in the bookmark.
  const StateIcon = type && state ? stateIcons[state] : null;
  // Ctrl or Cmd and a click on the poster or its title select it too. A click on a button or on the checkbox does its own work.
  const select = (event: MouseEvent) => {
    if (!selectable || (event.target as Element).closest('button, label')) return;
    event.preventDefault();
    onSelectedChange(!selected);
  };
  return (
    // On a Mac, Ctrl and a click give no click, but a context menu with the left button.
    <figure
      aria-busy={loading || undefined}
      onClick={event => (event.ctrlKey || event.metaKey) && select(event)}
      onContextMenu={event => event.ctrlKey && event.button === 0 && select(event)}
      className={`relative grid content-start ${noCaption ? '' : 'gap-3'} ${sizes[size]} max-w-full ${dimmed ? 'opacity-40' : ''} ${className}`}
    >
      <div className={`${block} group relative w-full aspect-2/3 rounded-md overflow-hidden`}>
        {/* Without a poster, the mark of the app shows faintly in its place, also while the poster loads, under the skeleton. */}
        {(!image || !ready) && <img src={emptyThumbnail} alt="" className="absolute inset-0 size-full object-cover opacity-30" />}
        {(loading || (image && !ready)) && <Skeleton className="absolute inset-0" />}
        {/* The title below names the image, so the image has no text of its own. */}
        {!loading && image && (
          <img
            src={image}
            alt=""
            loading="lazy"
            onLoad={() => setDone(image)}
            onError={() => setDone(image)}
            className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ease-stone motion-reduce:transition-none ${ready ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
        {overlay && !loading && (
          <div className="absolute inset-0 flex flex-wrap items-end justify-center gap-3 p-3 bg-night-deep/60 opacity-0 transition-opacity duration-200 ease-stone motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100">
            {overlay}
          </div>
        )}
        {selectable && (
          <div className={`absolute top-2 right-2 transition-opacity duration-200 ease-stone motion-reduce:transition-none ${selected ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
            <Checkbox aria-label={title} checked={selected} onCheckedChange={onSelectedChange} />
          </div>
        )}
      </div>
      <figcaption className="grid grid-cols-[minmax(0,1fr)] gap-1 px-1.5">
        {loading ? (
          // The bars have the height of the lines of the title and of the year.
          <>
            <Skeleton className="h-3.5 my-0.75 w-3/4" />
            <Skeleton className="h-3.25 w-10" />
          </>
        ) : (
          <>
            {/* With the status under the poster, or with no caption, the title stays for a screen reader. */}
            {noCaption || status ? (
              <span className="sr-only">{title}</span>
            ) : (
              <span title={title} className="truncate text-ink text-[15px]/5 font-medium">{title}</span>
            )}
            {!noCaption && status && <span className="truncate text-ink text-[15px]/5 font-medium">{status}</span>}
            {!noCaption && !status && year !== undefined && <span className="text-fog text-[13px]/none">{year}</span>}
            {/* The bookmark hangs from the top edge of the poster, with a notch in the bottom edge. It is in the caption, after its text, so it names the figure after the title and the year. The line is a face 1px inside the shape, so it follows the notch, and the shadow sits on the wrapper, outside the clip. The state shows as a tooltip when the pointer is on it. */}
            {type && (
              <span className={`${bookmarkShadow} absolute top-0 left-1.5 w-7`} title={state && stateLabel ? stateLabel : undefined}>
                <span className={`${bookmark} relative flex w-full min-h-14 flex-col items-center ${StateIcon ? 'justify-between' : 'justify-center'} gap-2 pt-2 pb-4 text-center text-[11px]/none font-[550] tracking-[.02em] ${notch}`}>
                  <span aria-hidden="true" className={`${bookmarkFace} absolute top-0 right-px bottom-px left-px ${notch}`} />
                  <span className="relative rotate-180 [writing-mode:vertical-rl]">{type}</span>
                  {StateIcon && (
                    <span className={`relative ${state === 'waiting' ? 'translate-y-0.5' : ''}`}>
                      <StateIcon className="size-4.5" />
                    </span>
                  )}
                  {state && stateLabel && <span className="sr-only">{stateLabel}</span>}
                </span>
              </span>
            )}
          </>
        )}
      </figcaption>
    </figure>
  );
}

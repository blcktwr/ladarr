import { useState } from 'react';
import type { ReactNode } from 'react';
import { block } from '../theme/stone.ts';
import { Skeleton } from './Skeleton.tsx';

type BackdropProps = {
  // The wide image of a film or a series. It is cropped at the center. No image shows the bare block.
  image?: string;
  // The skeleton of the banner while its data loads: a pulse on the block. Set loading on its content too.
  loading?: boolean;
  // The content over the banner, at the bottom left, such as a Thumbnail and a title.
  children?: ReactNode;
  className?: string;
};

// A banner at the top of the page of a film or a series. It lies on the page without a pane, and it fills the width of its parent.
// A gradient of the page color over the image dims it, more at the bottom, so the content over it is easy to read. The bottom of the banner fades into the page.
// While the image loads, the skeleton shows on the block. Then the image fades in. If the image does not load, the bare block stays.
// className is for layout only, such as a margin.
export function Backdrop({ image = '', loading = false, children, className = '' }: BackdropProps) {
  // The image that ended its load, so a new image starts with the skeleton.
  const [done, setDone] = useState('');
  const ready = done === image;
  return (
    <div aria-busy={loading || undefined} className={`relative grid items-end w-full min-h-96 ${className}`}>
      <div aria-hidden="true" className={`${block} absolute inset-0 rounded-lg overflow-hidden mask-b-from-40%`}>
        {(loading || (image && !ready)) && <Skeleton className="absolute inset-0" />}
        {/* The image is decoration, so it has no text. It fades in with its gradient. */}
        {!loading && image && (
          <div className={`absolute inset-0 transition-opacity duration-200 ease-stone motion-reduce:transition-none after:absolute after:inset-0 after:bg-linear-to-b after:from-night/50 after:to-night ${ready ? 'opacity-100' : 'opacity-0'}`}>
            <img src={image} alt="" onLoad={() => setDone(image)} onError={() => setDone(image)} className="size-full object-cover" />
          </div>
        )}
      </div>
      {children && <div className="relative flex flex-wrap items-end gap-6 p-6">{children}</div>}
    </div>
  );
}

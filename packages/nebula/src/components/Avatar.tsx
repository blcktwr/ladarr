import { useState } from 'react';
import emptyThumbnail from '../assets/empty-thumbnail.png';
import { block } from '../theme/stone.ts';
import { Skeleton } from './Skeleton.tsx';

// A round photo of a person, with the name under it. It is smaller than a poster, and its image loads as the image of a Thumbnail does.
export function Avatar({ image, name }: { image: string; name: string }) {
  // The image that ended its load, so a new image starts with the skeleton.
  const [done, setDone] = useState('');
  const ready = done === image;
  return (
    <figure className="grid grid-cols-[minmax(0,1fr)] w-24 gap-3">
      <div className={`${block} relative aspect-square rounded-full overflow-hidden`}>
        {(!image || !ready) && <img src={emptyThumbnail} alt="" className="absolute inset-0 size-full object-cover opacity-30" />}
        {image && !ready && <Skeleton className="absolute inset-0" />}
        {/* A photo of a person is tall, and the face is near its top, so the circle keeps the top. */}
        {image && (
          <img
            src={image}
            alt=""
            loading="lazy"
            onLoad={() => setDone(image)}
            onError={() => setDone(image)}
            className={`absolute inset-0 size-full object-cover object-top transition-opacity duration-200 ease-stone motion-reduce:transition-none ${ready ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
      </div>
      <figcaption title={name} className="truncate text-center text-ink text-[15px]/5 font-medium">{name}</figcaption>
    </figure>
  );
}

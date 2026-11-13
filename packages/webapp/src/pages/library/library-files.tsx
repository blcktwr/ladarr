import type { EpisodeRef, FileDetails, FileRow, PlanRequest } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Details as Fields, Dropdown, EmptyState, List, Modal, Row, Section, Spinner } from 'nebula';
import { Alert } from '../../components/alert.tsx';
import { LoadFailed } from '../../components/index.ts';
import { formatBytes, formatDuration } from '../../lib/format.ts';
import { t } from '../../i18n/index.ts';
import { episodeLabel, PlanDialog } from './library-bulk.tsx';

const stateText: Record<Exclude<FileDetails['state'], 'ok'>, string> = {
  missing: 'The file is not on the disk.',
  unreadable: 'ffprobe cannot read the file.',
  no_video: 'The file has no video stream.',
  root_unavailable: 'The library folder is missing, or its disk is not mounted.',
  ffprobe_missing: 'ffprobe is not installed.',
};

const bitrate = (bitsPerSecond: number) => `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbit/s`;
const fileName = (path: string) => path.split('/').at(-1) ?? path;

type Field = { label: string; value: string };

// The file as fields, in the groups of its data: the format, the video, the audio, and the subtitles.
// ffprobe reads the file when this component shows, and not before.
function FileInfo({ titleKey, fileId }: { titleKey: string; fileId: string }) {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ file: FileRow; details: FileDetails }>({ queryKey: [`/library/${titleKey}/files/${fileId}`] });
  if (loading && !data) return <Spinner label={t('Reading the file')} />;
  if (!data) {
    return error?.message === 'busy' ? (
      <Alert tone="warning">{t('ffprobe reads other files now. Try again in a moment.')}</Alert>
    ) : (
      <LoadFailed onRetry={reload} />
    );
  }
  const { file, details } = data;
  if (details.state !== 'ok') return <p>{t(stateText[details.state])}</p>;
  const { video } = details;
  const general: Field[] = [
    { label: t('Format'), value: details.container },
    ...(details.bitrate !== null ? [{ label: t('Bit rate'), value: bitrate(details.bitrate) }] : []),
    { label: t('Size'), value: formatBytes(file.sizeBytes) },
    ...(details.durationSeconds !== null ? [{ label: t('Duration'), value: formatDuration(details.durationSeconds) }] : []),
  ];
  const videoInfo: Field[] = video
    ? [
        { label: t('Codec'), value: video.codec },
        ...(video.width && video.height ? [{ label: t('Resolution'), value: `${video.width} × ${video.height}` }] : []),
        ...(video.aspectRatio ? [{ label: t('Aspect ratio'), value: video.aspectRatio }] : []),
        ...(video.frameRate ? [{ label: t('Frame rate'), value: `${video.frameRate} fps` }] : []),
        { label: t('Dolby Vision'), value: video.dolbyVision ? t('Yes') : t('No') },
      ]
    : [];
  const audio: Field[] = details.audio.length
    ? details.audio.map((track, index) => ({
        label: t('Audio {n}', { n: index + 1 }),
        value: `${track.language} · ${track.codec}${track.channels ? ` · ${track.channels} ch` : ''}`,
      }))
    : [{ label: t('Audio'), value: t('None') }];
  const subtitles: Field[] = details.subtitles.length
    ? details.subtitles.map((track, index) => ({ label: t('Subtitles {n}', { n: index + 1 }), value: `${track.language} · ${track.codec}` }))
    : [{ label: t('Subtitles'), value: t('None') }];
  return (
    <div className="grid gap-8 w-full">
      <Section title={t('General')}>
        <Fields items={general} />
      </Section>
      {videoInfo.length > 0 && (
        <Section title={t('Video')}>
          <Fields items={videoInfo} />
        </Section>
      )}
      <Section title={t('Audio')}>
        <Fields items={audio} />
      </Section>
      <Section title={t('Subtitles')}>
        <Fields items={subtitles} />
      </Section>
    </div>
  );
}

// The file of a resolution that the page shows as a badge. A title can have more than one, so the user picks one.
export function FileInfoDialog({ titleKey, resolution, onClose }: { titleKey: string; resolution: number; onClose: () => void }) {
  const { data, error, refetch } = useQuery<{ files: FileRow[] }>({ queryKey: [`/library/${titleKey}/files`] });
  const [chosen, setChosen] = useState<string | null>(null);
  const files = (data?.files ?? []).filter((file) => file.resolution === resolution);
  const current = files.find((file) => file.id === chosen) ?? files[0];
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('Downloaded file')}
      hideTitle
      width="lg"
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t('Close')}
        </Button>
      }
    >
      {error && !data ? (
        <LoadFailed onRetry={() => void refetch()} />
      ) : !data ? (
        <Spinner label={t('Loading')} />
      ) : !current ? (
        <EmptyState>{t('No file is recorded.')}</EmptyState>
      ) : (
        <>
          {files.length > 1 && (
            <Dropdown label={t('File')} value={current.id} options={files.map((file) => ({ value: file.id, label: file.episodes.length > 0 ? episodeLabel(file.episodes) : fileName(file.path) }))} onValueChange={(value) => setChosen(value)} />
          )}
          <FileInfo titleKey={titleKey} fileId={current.id} />
        </>
      )}
    </Modal>
  );
}

function FileItem({ titleKey, file, onDelete }: { titleKey: string; file: FileRow; onDelete: () => void }) {
  const [shown, setShown] = useState(false);
  return (
    <Row
      actions={
        <>
          <Button variant="ghost" onClick={() => setShown(!shown)}>
            {shown ? t('Hide details') : t('Show details')}
          </Button>
          <Button variant="danger" onClick={onDelete}>
            {t('Delete file')}
          </Button>
        </>
      }
    >
      <span>{file.path}</span>
      <span>
        {formatBytes(file.sizeBytes)}
        {file.episodes.length > 0 ? `, ${episodeLabel(file.episodes)}` : ''}
      </span>
      {file.missing && <Badge tone="warning">{t('Not on the disk at the last scan')}</Badge>}
      {shown && (
        <div className="w-full">
          <FileInfo titleKey={titleKey} fileId={file.id} />
        </div>
      )}
    </Row>
  );
}

// The files of a title, or the file of one episode. It shows in the page where the dialog was.
export function FilesDialog({ titleKey, episode, onClose }: { titleKey: string; episode?: EpisodeRef; onClose: () => void }) {
  const query = episode ? `?season=${episode.season}&number=${episode.number}` : '';
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ files: FileRow[] }>({ queryKey: [`/library/${titleKey}/files${query}`] });
  const [plan, setPlan] = useState<PlanRequest | null>(null);

  return (
    <Section
      title={episode ? t('File of {episode}', { episode: episodeLabel([episode]) }) : t('Files')}
      actions={
        <Button variant="ghost" autoFocus onClick={onClose}>
          {t('Close')}
        </Button>
      }
    >
      {error && !data ? <LoadFailed onRetry={reload} /> : loading && !data ? <Spinner label={t('Loading')} /> : null}
      {data?.files.length === 0 && <EmptyState>{t('No file is recorded.')}</EmptyState>}
      {data && data.files.length > 0 && (
        <List>
          {data.files.map((file) => (
            <FileItem key={file.id} titleKey={titleKey} file={file} onDelete={() => setPlan({ action: 'delete_files', keys: [titleKey], fileIds: [file.id] })} />
          ))}
        </List>
      )}
      <PlanDialog request={plan} onClose={() => setPlan(null)} onDone={() => void reload()} />
    </Section>
  );
}

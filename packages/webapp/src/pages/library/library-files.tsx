import type { EpisodeRef, FileDetails, FileRow, PlanRequest } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, EmptyState, List, Row, Section, Spinner } from 'nebula';
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

// ffprobe reads the file when this component shows, and not before.
function Details({ titleKey, fileId }: { titleKey: string; fileId: string }) {
  const { data, error, isFetching: loading, refetch: reload } = useQuery<{ details: FileDetails }>({ queryKey: [`/library/${titleKey}/files/${fileId}`] });
  if (loading && !data) return <Spinner label={t('Reading the file')} />;
  if (!data) {
    return error?.message === 'busy' ? (
      <Alert tone="warning">{t('ffprobe reads other files now. Try again in a moment.')}</Alert>
    ) : (
      <LoadFailed onRetry={reload} />
    );
  }
  const { details } = data;
  if (details.state !== 'ok') return <p>{t(stateText[details.state])}</p>;
  const { video } = details;
  return (
    <dl>
      <dt>{t('Container')}</dt>
      <dd>{details.container}</dd>
      {details.durationSeconds !== null && (
        <>
          <dt>{t('Duration')}</dt>
          <dd>{formatDuration(details.durationSeconds)}</dd>
        </>
      )}
      {details.bitrate !== null && (
        <>
          <dt>{t('Bit rate')}</dt>
          <dd>{bitrate(details.bitrate)}</dd>
        </>
      )}
      {video && (
        <>
          <dt>{t('Video')}</dt>
          <dd>
            {video.codec}
            {video.width && video.height ? `, ${video.width}x${video.height}` : ''}
            {video.frameRate ? `, ${video.frameRate} fps` : ''}
          </dd>
        </>
      )}
      <dt>{t('Audio')}</dt>
      <dd>{details.audio.length ? details.audio.map((a) => `${a.language} ${a.codec}${a.channels ? ` ${a.channels} ch` : ''}`).join('; ') : t('None')}</dd>
      <dt>{t('Subtitles')}</dt>
      <dd>{details.subtitles.length ? details.subtitles.map((s) => `${s.language} ${s.codec}`).join('; ') : t('None')}</dd>
    </dl>
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
      {shown && <Details titleKey={titleKey} fileId={file.id} />}
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

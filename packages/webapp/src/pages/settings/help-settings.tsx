import { Badge, List, Row, Section, Text } from 'nebula';
import { t } from '../../i18n/index.ts';

type Entry = { name: string; text: string };

// The parts of the journey of an item, each one with its events. The text tells what an event means, in simple words.
const groups: { title: string; text: string; events: Entry[] }[] = [
  {
    title: 'In the queue',
    text: 'The target is in the queue. These events show each change of its stage.',
    events: [
      { name: 'queued', text: 'The target entered the queue. ladarr searches for this target until the library has its file.' },
      { name: 'moved', text: 'The target changed stage. The line shows the old stage and the new stage, with the branch. The cause is in the fields.' },
      { name: 'started', text: 'A new try started for the target. A target can have more than one try.' },
      { name: 'attempt_ended', text: 'The try ended. The line shows the result: imported, failed, or cancelled.' },
    ],
  },
  {
    title: 'The search',
    text: 'A search asks the indexers for a release. A group of episodes makes one search.',
    events: [
      { name: 'search', text: 'A search asks the indexers with the quality profiles of the title, from the first of the chain. Each answer is a line with the indexer, the query, and the number of releases. Zero is a valid answer.' },
      { name: 'finished', text: 'The search ended with no release. The line shows the number of releases and the primary reason.' },
      { name: 'search_deferred', text: 'The search reached its request budget. It continues in the next run.' },
      { name: 'release_chosen', text: 'ladarr selected one release from one indexer. The next step is the download.' },
      { name: 'release_failed', text: 'The release had a problem, for example a broken torrent. It goes to the blocklist and the target starts a new try.' },
    ],
  },
  {
    title: 'The download',
    text: 'ladarr sends the selected release to the download client.',
    events: [
      { name: 'download_started', text: 'ladarr sends the release to the download client.' },
      { name: 'download_added', text: 'The client accepted the torrent and started the download.' },
      { name: 'download_exists', text: 'The torrent was in the client before this request. It belongs to the user, thus ladarr does not use it.' },
      { name: 'download_completed', text: 'The client has all the data. The next step is the import.' },
      { name: 'download_failed', text: 'The client did not accept the release. The line shows the code and the number of the try.' },
      { name: 'download_no_client', text: 'No download client is available. ladarr cannot send the release.' },
    ],
  },
  {
    title: 'The import',
    text: 'The files of the download go to the library.',
    events: [
      { name: 'import_started', text: 'The import started. The files of the download go to the library.' },
      { name: 'import_planned', text: 'The plan of the import: the source file, the destination name, and the method.' },
      { name: 'import_staged', text: 'The file is in the folder of the title with a temporary name.' },
      { name: 'import_published', text: 'The file has its final name.' },
      { name: 'import_committed', text: 'The library record is current. The target has the file.' },
      { name: 'import_retired', text: 'The new file replaced an old file. The old file is deleted.' },
      { name: 'import_completed', text: 'The import ended and the target is available.' },
      { name: 'import_blocked', text: 'The import stopped on a known problem, for example a folder that is not available. The line shows the code.' },
      { name: 'import_failed', text: 'The import stopped on an error. The file is not in the library.' },
    ],
  },
  {
    title: 'The title',
    text: 'A title is a movie or a series before it has targets.',
    events: [
      { name: 'added', text: 'The title entered the library with its quality profile.' },
      { name: 'episodes', text: 'The episodes of the series are loaded. The queue can now search for them.' },
      { name: 'refreshed', text: 'ladarr read the metadata of the title from TMDB again.' },
      { name: 'waiting', text: 'The first search waits for the episodes of the series.' },
      { name: 'empty', text: 'The first search found no target. For example, no episode is due.' },
    ],
  },
];

export function Help() {
  return (
    <>
      <Section title={t('Items')}>
        <Text>{t('An item is one target: a movie, or one episode of a series. ladarr follows every item from the queue to the library.')}</Text>
        <Text>{t('Each line of the log shows the time, the event, and a message. The event is the action of the step. Click a line to show the fields of that step.')}</Text>
      </Section>
      {groups.map((group) => (
        <Section key={group.title} title={t(group.title)}>
          <Text variant="small">{t(group.text)}</Text>
          <List>
            {group.events.map((event) => (
              <Row key={event.name}>
                <Badge>{event.name}</Badge>
                <Text variant="small">{t(event.text)}</Text>
              </Row>
            ))}
          </List>
        </Section>
      ))}
    </>
  );
}

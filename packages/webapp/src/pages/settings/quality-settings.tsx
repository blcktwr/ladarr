import type { ProfileData, QualityResponse, QualityRow } from '@ladarr/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { Actions, Badge, Button, Checkbox, Field, Hint, Modal, Section, Table } from 'nebula';
import { Alert, Confirm, ModalActions } from '../../components/index.ts';
import { LoadFailed } from '../../components/load-failed.tsx';
import { api } from '../../lib/api.ts';
import { describeError } from '../../lib/format.ts';
import { ordinal, t } from '../../i18n/index.ts';

// What each resolution means, and how it differs from the others.
const RESOLUTION_INFO: Record<number, string> = {
  2160: 'Also called 4K or Ultra HD. The picture is 3840 by 2160 pixels, four times the pixels of 1080p. The files are the largest. The difference shows only on a 4K screen.',
  1080: 'Also called Full HD. The picture is 1920 by 1080 pixels. Standard Blu-ray discs use this size. The files are smaller than 2160p files and larger than 720p files.',
  720: 'Also called HD. The picture is 1280 by 720 pixels, less than half the pixels of 1080p. The files are smaller than 1080p files. The loss of detail shows on large screens.',
  480: 'Also called SD, for standard definition. The picture is 480 pixels high, as on a DVD. The files are the smallest. The picture is soft on large screens.',
};

// A quality of the profile, the best first. `same` is true when it has the rank of the quality above it.
type Slot = { id: string; same: boolean };
type Draft = { name: string; slots: Slot[] };

const toDraft = (profile: ProfileData | undefined): Draft => ({
  name: profile?.name ?? '',
  slots: (profile?.items ?? []).flatMap((group) => group.map((id, index) => ({ id, same: index > 0 }))),
});

function toItems(slots: Slot[]) {
  const groups: string[][] = [];
  for (const slot of slots) {
    if (slot.same && groups.length) groups.at(-1)!.push(slot.id);
    else groups.push([slot.id]);
  }
  return groups;
}

// A quality that leaves the profile does not pull the next quality into the group above.
function remove(slots: Slot[], index: number) {
  const next = slots.filter((_, i) => i !== index);
  if (!slots[index]!.same && next[index]) next[index] = { ...next[index]!, same: false };
  return next;
}

function ProfileModal({ profile, qualities, onSaved }: { profile?: ProfileData; qualities: QualityRow[]; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const { slots } = draft;
  const groups = toItems(slots);
  const ranks = slots.map((slot, index) => groups.findIndex((group) => group.includes(slot.id)) + 1 || index + 1);
  const set = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes });
  // The table has a column for each source, the best first, and a row for each resolution, the highest first. A quality with no resolution, such as a DVD, goes in the lowest row.
  const resolutions = [...new Set(qualities.flatMap((quality) => quality.resolution ?? []))].sort((a, b) => b - a);
  const sources = [...new Set([...qualities].reverse().map((quality) => quality.source))];
  const sourceName = (source: string) => {
    const quality = qualities.find((candidate) => candidate.source === source)!;
    return quality.resolution ? quality.label.replace(` ${quality.resolution}p`, '') : quality.label;
  };
  const toggle = (id: string) => {
    const index = slots.findIndex((slot) => slot.id === id);
    set({ slots: index < 0 ? [...slots, { id, same: false }] : remove(slots, index) });
  };

  async function save() {
    if (!draft.name.trim()) return setError(t('Enter a name.'));
    if (!slots.length) return setError(t('Allow at least one quality.'));
    setPending(true);
    setError('');
    try {
      const body = { name: draft.name.trim(), items: groups };
      await api<{ profile: ProfileData }>(profile ? `/quality/profiles/${profile.id}` : '/quality/profiles', { method: profile ? 'PUT' : 'POST', body });
      setOpen(false);
      await onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(toDraft(profile));
          setError('');
        }
        setOpen(next);
      }}
      title={profile ? t('Edit {name}', { name: profile.name }) : t('Add a profile')}
      width="xl"
      trigger={
        profile ? (
          <Button variant="ghost" aria-label={t('Edit {name}', { name: profile.name })}>
            {t('Edit')}
          </Button>
        ) : (
          <Button>
            <Plus />
            {t('Add profile')}
          </Button>
        )
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('Name')} required value={draft.name} onValueChange={(name) => set({ name })} />
      <Section title={t('Qualities')}>
        <Table
          aria-label={t('Qualities')}
          columns={[{ label: t('Resolution') }, ...sources.map((source) => ({ label: sourceName(source) }))]}
          rows={resolutions.map((resolution) => ({
            key: String(resolution),
            cells: [
              <div className="flex items-center gap-1">
                {resolution}p
                {RESOLUTION_INFO[resolution] && <Hint label={t('About {resolution}p', { resolution })}>{t(RESOLUTION_INFO[resolution])}</Hint>}
              </div>,
              ...sources.map((source) => {
                const quality = qualities.find((candidate) => candidate.source === source && (candidate.resolution ?? resolutions.at(-1)) === resolution);
                if (!quality) return null;
                const index = slots.findIndex((slot) => slot.id === quality.id);
                return (
                  <div className="flex items-center gap-2">
                    <Checkbox aria-label={quality.label} checked={index >= 0} onCheckedChange={() => toggle(quality.id)} />
                    {/* The slot keeps its width without a rank, so the columns do not move when a quality is checked. */}
                    <div className="w-10">{index >= 0 && <Badge>{ranks[index]}</Badge>}</div>
                  </div>
                );
              }),
            ],
          }))}
        />
      </Section>
      <ModalActions>
        <Button pending={pending} onClick={save}>
          {t('Save')}
        </Button>
      </ModalActions>
    </Modal>
  );
}

export function Qualities() {
  const { data, error, refetch } = useQuery<QualityResponse>({ queryKey: ['/quality'] });
  const client = useQueryClient();
  const [message, setMessage] = useState('');
  const profiles = data?.profiles ?? [];
  const qualities = data?.qualities ?? [];
  // The profiles are in the lists of Settings and of the catalog too.
  const refresh = () => Promise.all([refetch(), client.invalidateQueries({ queryKey: ['/settings'] })]);

  async function remove(profile: ProfileData) {
    setMessage('');
    try {
      await api(`/quality/profiles/${profile.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= profiles.length) return;
    const ids = profiles.map((profile) => profile.id);
    [ids[index], ids[next]] = [ids[next]!, ids[index]!];
    setMessage('');
    try {
      await api('/quality/order', { method: 'PUT', body: { ids } });
      await refresh();
    } catch (err) {
      setMessage(describeError(err));
    }
  }

  return (
    <Section title={t('Qualities')} action={data && <ProfileModal qualities={qualities} onSaved={refresh} />}>
      {message && <Alert tone="danger">{message}</Alert>}
      {error && !data ? (
        <LoadFailed onRetry={refetch} />
      ) : (
        <Table
          aria-label={t('Quality profiles')}
          loading={!data}
          columns={[{ label: t('Name') }, { label: t('Actions'), align: 'end' }]}
          rows={data && profiles.map((profile, index) => ({
            key: profile.id,
            cells: [
              <div className="flex items-center gap-3">
                <strong>{profile.name}</strong>
                <Badge>{ordinal(index + 1)}</Badge>
              </div>,
              <div className="flex justify-end">
                <Actions>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('Move {name} up', { name: profile.name })}
                    disabled={index === 0}
                    onClick={() => void move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('Move {name} down', { name: profile.name })}
                    disabled={index === profiles.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <ProfileModal profile={profile} qualities={qualities} onSaved={refresh} />
                  <Confirm label={t('Delete')} title={t('Delete {name}?', { name: profile.name })} confirm={t('Delete')} onConfirm={() => void remove(profile)}>
                    {t('Titles that use this profile must use another one first.')}
                  </Confirm>
                </Actions>
              </div>,
            ],
          }))}
        />
      )}
    </Section>
  );
}

import type { ProfileData, QualityResponse, QualityRow, SizeLimits } from '@ladarr/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ActionMenu, Actions, Badge, Button, Checkbox, Confirm, Field, Hint, Modal, Section, Table, Text } from 'nebula';
import { Alert, ModalActions } from '../../components/index.ts';
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

// What each source means, and how it differs from the others.
const SOURCE_INFO: Record<string, string> = {
  remux: 'The complete picture of a Blu-ray disc, without compression. The quality is the best, and the files are the largest.',
  bluray: 'A compressed copy of a Blu-ray disc. The quality is high, and the file is smaller than a remux file.',
  webdl: 'A file from a streaming service, without compression. The picture keeps its quality, and the file is larger than a WEBRip file of the same resolution.',
  webrip: 'A capture of a streaming service, usually compressed. The file is smaller than a WEB-DL file, and the picture has less detail.',
  rawhd: 'A capture of a TV broadcast, without compression. The file is very large, and the picture keeps the quality of the broadcast.',
  hdtv: 'A capture of a TV broadcast, usually compressed. The quality can change, and the picture can have the logo of the channel.',
  sdtv: 'A capture of a TV broadcast in standard definition. The picture is soft on large screens.',
  dvd: 'A copy of a DVD disc. The picture is not high definition, so it is soft on large screens.',
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

// The size limits of a quality, in MiB per minute of video. A limit belongs to the quality, so every profile that takes the quality uses the same one.
type Sizes = { min: string; preferred: string; max: string };

const toSizes = ({ min, preferred, max }: SizeLimits): Sizes => ({
  min: String(min),
  preferred: preferred === null ? '' : String(preferred),
  max: max === null ? '' : String(max),
});

const toSizesOf = (qualities: QualityRow[]) => Object.fromEntries(qualities.map((quality) => [quality.id, toSizes(quality.sizes)]));

// The three limits in order, or null. An empty preferred or max limit is not checked.
function parseSizes({ min, preferred, max }: Sizes): SizeLimits | null {
  const low = min.trim() === '' ? null : Number(min);
  const mid = preferred.trim() === '' ? null : Number(preferred);
  const high = max.trim() === '' ? null : Number(max);
  const ordered =
    low !== null && Number.isFinite(low) && low >= 0 &&
    (mid === null || (Number.isFinite(mid) && mid >= low)) &&
    (high === null || (Number.isFinite(high) && high >= (mid ?? low)));
  return ordered ? { min: low, preferred: mid, max: high } : null;
}

// The three limits, in the order of the rows under an expanded resolution.
const LIMITS = [
  { key: 'min', label: 'Minimum', name: 'Minimum for {name}' },
  { key: 'preferred', label: 'Preferred', name: 'Preferred for {name}' },
  { key: 'max', label: 'Maximum', name: 'Maximum for {name}' },
] as const;

function ProfileModal({ profile, qualities, open, onOpenChange, onSaved }: { profile?: ProfileData; qualities: QualityRow[]; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  const [sizes, setSizes] = useState<Record<string, Sizes>>(() => toSizesOf(qualities));
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const { slots } = draft;
  const groups = toItems(slots);
  const ranks = slots.map((slot, index) => groups.findIndex((group) => group.includes(slot.id)) + 1 || index + 1);
  const set = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes });
  const setSize = (id: string, next: Sizes) => setSizes({ ...sizes, [id]: next });
  const current = (quality: QualityRow) => sizes[quality.id] ?? toSizes(quality.sizes);
  // The table has a column for each source, the best first, and a row for each resolution, the highest first. A quality with no resolution, such as a DVD, goes in the lowest row.
  const resolutions = [...new Set(qualities.flatMap((quality) => quality.resolution ?? []))].sort((a, b) => b - a);
  const sources = [...new Set([...qualities].reverse().map((quality) => quality.source))];
  const sourceName = (source: string) => {
    // The column of a remux is narrow, so its header drops "BluRay": the column next to it is BluRay.
    if (source === 'remux') return 'Remux';
    const quality = qualities.find((candidate) => candidate.source === source)!;
    return quality.resolution ? quality.label.replace(` ${quality.resolution}p`, '') : quality.label;
  };
  const qualityAt = (source: string, resolution: number) =>
    qualities.find((candidate) => candidate.source === source && (candidate.resolution ?? resolutions.at(-1)) === resolution);
  const toggle = (id: string) => {
    const index = slots.findIndex((slot) => slot.id === id);
    set({ slots: index < 0 ? [...slots, { id, same: false }] : remove(slots, index) });
  };

  // The modal opens with the saved profile, not with what an earlier try left in the form.
  useEffect(() => {
    if (!open) return;
    setDraft(toDraft(profile));
    setSizes(toSizesOf(qualities));
    setExpanded(null);
    setError('');
  }, [open]);

  async function save() {
    if (!draft.name.trim()) return setError(t('Enter a name.'));
    if (!slots.length) return setError(t('Allow at least one quality.'));
    const changed: { id: string; sizes: SizeLimits }[] = [];
    for (const id of groups.flat()) {
      const quality = qualities.find((candidate) => candidate.id === id);
      if (!quality) continue;
      const next = parseSizes(sizes[id] ?? toSizes(quality.sizes));
      if (!next) return setError(t('The sizes are not in order. The minimum is the smallest, then the preferred size, then the maximum.'));
      if (next.min !== quality.sizes.min || next.preferred !== quality.sizes.preferred || next.max !== quality.sizes.max) changed.push({ id, sizes: next });
    }
    setPending(true);
    setError('');
    try {
      const body = { name: draft.name.trim(), items: groups };
      await api<{ profile: ProfileData }>(profile ? `/quality/profiles/${profile.id}` : '/quality/profiles', { method: profile ? 'PUT' : 'POST', body });
      for (const { id, sizes: limits } of changed) await api(`/quality/sizes/${id}`, { method: 'PUT', body: limits });
      onOpenChange(false);
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
      onOpenChange={onOpenChange}
      title={profile ? t('Edit quality') : t('Add a profile')}
      width="xl"
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={t('Name')} required value={draft.name} onValueChange={(name) => set({ name })} />
      <div className="@container w-full">
        <Table
          aria-label={t('Qualities')}
          stickyFirst
          minWidth="62rem"
          columns={[
            {
              label: t('Resolution'),
              hideLabel: true,
              width: '10rem',
            },
            ...sources.map((source) => ({
              label: <span title={SOURCE_INFO[source] ? t(SOURCE_INFO[source]) : undefined}>{sourceName(source)}</span>,
              width: '6.5rem',
            })),
          ]}
          rows={resolutions.map((resolution) => {
            const rowQualities = sources
              .map((source) => qualityAt(source, resolution))
              .filter((quality): quality is QualityRow => quality !== undefined);
            const open = expanded === resolution && rowQualities.length > 0;
            return {
              key: String(resolution),
              active: open,
              cells: [
                <div className={open ? 'relative mb-8 grid' : 'grid'}>
                  <div className="flex h-12 items-center gap-1">
                    <Button
                      variant="ghost"
                      iconOnly
                      disabled={!rowQualities.length}
                      aria-label={open ? t('Hide size limits for {resolution}p', { resolution }) : t('Show size limits for {resolution}p', { resolution })}
                      onClick={() => setExpanded(open ? null : resolution)}
                    >
                      {open ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                    {resolution}p
                    {RESOLUTION_INFO[resolution] && <Hint label={t('About {resolution}p', { resolution })}>{t(RESOLUTION_INFO[resolution])}</Hint>}
                  </div>
                  {open && (
                    <div className="mt-3 grid gap-2.5">
                      {LIMITS.map((limit) => (
                        <div key={limit.key} className="flex h-7 items-center justify-end">
                          <Text variant="small">{t(limit.label)}</Text>
                        </div>
                      ))}
                    </div>
                  )}
                  {open && (
                    <div className="absolute left-0 top-full mt-3 flex w-[100cqw] justify-center">
                      <Text variant="small">{t('Size limit (MiB per minute)')}</Text>
                    </div>
                  )}
                </div>,
                ...sources.map((source) => {
                  const quality = qualityAt(source, resolution);
                  if (!quality) return null;
                  const index = slots.findIndex((slot) => slot.id === quality.id);
                  return (
                    <div className={open ? 'mb-8 grid' : 'grid'}>
                      <div className="flex h-12 items-center gap-1">
                        <Checkbox aria-label={quality.label} checked={index >= 0} onCheckedChange={() => toggle(quality.id)} />
                        {index >= 0 && <Badge>{ranks[index]}</Badge>}
                      </div>
                      {open && (
                        <div className="mt-3 grid gap-2.5">
                          {LIMITS.map((limit) => (
                            <Field
                              key={limit.key}
                              size="sm"
                              hideLabel
                              width="xs"
                              label={t(limit.name, { name: quality.label })}
                              type="number"
                              min="0"
                              step="any"
                              placeholder={limit.key === 'min' ? undefined : '∞'}
                              value={current(quality)[limit.key]}
                              onValueChange={(text) => setSize(quality.id, { ...current(quality), [limit.key]: text })}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }),
              ],
            };
          })}
        />
      </div>
      <ModalActions>
        <div className="mr-auto">
          <Text variant="small">{t('The priority is given by the order in which you select.')}</Text>
        </div>
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
  // The modal of the profile stays on its last profile while it closes, so the close keeps its title.
  const [editing, setEditing] = useState<ProfileData | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProfileData | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
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
    <Section
      title={t('Qualities')}
      action={data && (
        <Button onClick={() => { setEditing(null); setEditOpen(true); }}>
          <Plus />
          {t('Add profile')}
        </Button>
      )}
    >
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
                  {index > 0 && (
                    <Button
                      variant="ghost"
                      iconOnly
                      aria-label={t('Move {name} up', { name: profile.name })}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={t('Move {name} down', { name: profile.name })}
                    disabled={index === profiles.length - 1}
                    onClick={() => void move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <ActionMenu
                    label={t('Actions for {name}', { name: profile.name })}
                    items={[
                      { label: t('Edit'), onClick: () => { setEditing(profile); setEditOpen(true); } },
                      { label: t('Delete'), danger: true, onClick: () => { setDeleting(profile); setDeleteOpen(true); } },
                    ]}
                  />
                </Actions>
              </div>,
            ],
          }))}
        />
      )}
      <ProfileModal profile={editing ?? undefined} qualities={qualities} open={editOpen} onOpenChange={setEditOpen} onSaved={refresh} />
      {deleting && (
        <Confirm
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t('Delete {name}?', { name: deleting.name })}
          confirm={t('Delete')}
          onConfirm={() => { setDeleteOpen(false); void remove(deleting); }}
        >
          {t('Titles that use this profile must use another one first.')}
        </Confirm>
      )}
    </Section>
  );
}

import type { Numbering, NumberingRange, TitleDetail } from '@ladarr/shared/types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, Field, Form, Modal, Table } from 'nebula';
import { api, ApiError } from '../lib/api.ts';
import { describeError } from '../lib/format.ts';
import { t } from '../i18n/index.ts';
import { Alert } from './alert.tsx';

// One range of the form. The inputs hold text, so a field can be empty while the user writes.
type Row = { season: string; from: string; to: string; releaseSeason: string; releaseFrom: string };
type FieldProblem = { index: number; field: string | null; message: string };

const empty = (): Row => ({ season: '', from: '', to: '', releaseSeason: '', releaseFrom: '' });
const asRow = (range: NumberingRange): Row => ({
  season: String(range.season),
  from: String(range.from),
  to: String(range.to),
  releaseSeason: String(range.releaseSeason),
  releaseFrom: String(range.releaseFrom),
});

const pad = (value: number) => String(value).padStart(2, '0');

// The release episodes that a row names. The end follows from the length of the range.
function releaseText(row: Row) {
  const season = Number(row.releaseSeason);
  const first = Number(row.releaseFrom);
  const from = Number(row.from);
  const to = Number(row.to);
  if (![season, first, from, to].every((value) => Number.isSafeInteger(value) && value >= 0) || first < 1 || from < 1 || to < from) return '';
  return `S${pad(season)}E${pad(first)}–S${pad(season)}E${pad(first + to - from)}`;
}

// The numbering of a series: the catalog episodes of each range and the release episodes that they name. The user saves
// the map, so a search asks for the release numbers of the episodes that it needs.
export function NumberingDialog({
  titleKey,
  open,
  onOpenChange,
  onSaved,
}: {
  titleKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void | Promise<void>;
}) {
  const { data, error, refetch } = useQuery<{ title: TitleDetail }>({ queryKey: [`/library/${titleKey}`], enabled: open });
  const [rows, setRows] = useState<Row[]>([]);
  const [revision, setRevision] = useState(0);
  const [problem, setProblem] = useState<FieldProblem | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  // Each opening starts from the saved map. A save that changed the map also resets the rows.
  useEffect(() => {
    if (!open) return;
    const numbering: Numbering = data?.title.numbering ?? { revision: 0, ranges: [] };
    setRows(numbering.ranges.map(asRow));
    setRevision(numbering.revision);
    setProblem(null);
    setMessage('');
  }, [open, data?.title.numbering]);

  const change = (index: number, field: keyof Row, value: string) => {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
    setProblem(null);
  };
  const errorOf = (index: number, field: string) => (problem?.index === index && problem.field === field ? problem.message : undefined);

  async function save() {
    setPending(true);
    setMessage('');
    setProblem(null);
    try {
      const ranges = rows.map((row) => ({
        season: Number(row.season),
        from: Number(row.from),
        to: Number(row.to),
        releaseSeason: Number(row.releaseSeason),
        releaseFrom: Number(row.releaseFrom),
      }));
      await api(`/library/${titleKey}`, { method: 'PATCH', body: { numbering: { revision, ranges } } });
      await refetch();
      onOpenChange(false);
      await onSaved?.();
    } catch (err) {
      if (err instanceof ApiError && err.message === 'invalid_numbering') {
        const index = typeof err.body.index === 'number' ? err.body.index : -1;
        const field = typeof err.body.field === 'string' ? err.body.field : null;
        if (index >= 0 && field) setProblem({ index, field, message: t('The value is not valid.') });
        else setMessage(t('The episode map is not valid. Check the ranges.'));
      } else if (err instanceof ApiError && err.message === 'numbering_changed') {
        setMessage(t('The episode map changed in another place. Open it again.'));
        await refetch();
      } else setMessage(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('Edit numbering')}
      width="xl"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button type="button" pending={pending} onClick={() => void save()}>
            {t('Save numbering')}
          </Button>
        </>
      }
    >
      {message && <Alert tone="danger">{message}</Alert>}
      {error && !data && <Alert tone="danger">{describeError(error)}</Alert>}
      <Form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Table
          aria-label={t('Edit numbering')}
          columns={[
            { label: t('Catalog season'), width: '8rem' },
            { label: t('First catalog episode'), width: '9rem' },
            { label: t('Last catalog episode'), width: '9rem' },
            { label: t('Release season'), width: '8rem' },
            { label: t('First release episode'), width: '9rem' },
            { label: t('Release episodes') },
            { label: t('Remove'), hideLabel: true, align: 'end', width: '6rem' },
          ]}
          rows={rows.map((row, index) => ({
            key: String(index),
            cells: [
              <Field size="sm" hideLabel label={t('Catalog season')} type="number" min={0} value={row.season} onChange={(event) => change(index, 'season', event.target.value)} error={errorOf(index, 'season')} />,
              <Field size="sm" hideLabel label={t('First catalog episode')} type="number" min={1} value={row.from} onChange={(event) => change(index, 'from', event.target.value)} error={errorOf(index, 'from')} />,
              <Field size="sm" hideLabel label={t('Last catalog episode')} type="number" min={1} value={row.to} onChange={(event) => change(index, 'to', event.target.value)} error={errorOf(index, 'to')} />,
              <Field size="sm" hideLabel label={t('Release season')} type="number" min={0} value={row.releaseSeason} onChange={(event) => change(index, 'releaseSeason', event.target.value)} error={errorOf(index, 'releaseSeason')} />,
              <Field size="sm" hideLabel label={t('First release episode')} type="number" min={1} value={row.releaseFrom} onChange={(event) => change(index, 'releaseFrom', event.target.value)} error={errorOf(index, 'releaseFrom')} />,
              releaseText(row),
              <Button type="button" variant="ghost" onClick={() => setRows((current) => current.filter((_, at) => at !== index))}>
                {t('Remove')}
              </Button>,
            ],
          }))}
          action={
            <Button type="button" onClick={() => setRows((current) => [...current, empty()])}>{t('Add range')}</Button>
          }
        />
      </Form>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';

const label = value => value.replace(/([a-z])([A-Z])/g, '$1 $2');
const display = value => value === null || value === undefined || value === '' ? 'None' : typeof value === 'boolean' ? value ? 'Enabled' : 'Disabled' : String(value);

/** Mounted with a planHash key: page coverage and acknowledgement cannot carry into another preview. */
export default function RosterChangeReview({ runId, planHash, onReviewed }) {
  const [page, setPage] = useState(0);
  const [seen, setSeen] = useState([]);
  const { data, error, isFetching } = useQuery({ queryKey: ['roster-named-review', runId, planHash, page], queryFn: ({ signal }) => apiRequest('GET', `/classpilot/roster-integrations/runs/${runId}/review?planHash=${encodeURIComponent(planHash)}&page=${page}`, undefined, { signal }) });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 0;
  const viewed = new Set([...seen, ...(data?.planHash === planHash ? [data.page] : [])]);
  const complete = Boolean(pages && viewed.size === pages && !error && data?.planHash === planHash);
  const changePage = next => { if (data?.planHash === planHash) setSeen([...viewed]); setPage(next); };
  useEffect(() => { onReviewed(complete ? planHash : null); }, [complete, planHash, onReviewed]);
  return <section className="space-y-3 rounded border p-3" aria-label="Named roster changes">
    <h5 className="font-medium">Review names and field changes</h5>
    <p className="text-xs text-muted-foreground">These names and values are saved with this preview. Review every page before approving a held import. Archiving keeps the class history and memberships; it disables the schedule.</p>
    {error && <p role="alert" className="text-sm text-destructive">The saved review could not be loaded. Create a fresh preview or retry this page.</p>}
    {isFetching && <p role="status" className="text-sm">Loading changes…</p>}
    {data?.planHash === planHash && <>
      <ol className="space-y-2">{data.rows.map((row, index) => <li key={`${row.stepIndex}:${data.page}:${index}`} className="break-words rounded bg-muted p-2 text-sm">
        <p className="font-medium">{row.name} <span className="text-xs font-normal text-muted-foreground">({row.kind})</span></p>
        {row.type === 'field' && <p><span className="capitalize">{label(row.field.field)}</span>: <span>{row.field.beforeLabel || display(row.field.before)}</span> → <span>{row.field.afterLabel || display(row.field.after)}</span></p>}
        {row.type === 'membership' && <p>{!row.member.beforeRole ? 'Add' : !row.member.afterRole ? 'Remove' : 'Change role for'} {row.member.memberType}: <strong>{row.member.name}</strong> · {row.member.beforeRole || 'Not enrolled'} → {row.member.afterRole || 'Not enrolled'}</p>}
        {row.type === 'record' && <p className="text-muted-foreground">{row.create ? 'Create this record.' : 'Link or retain this record. No field or membership changes.'}</p>}
      </li>)}</ol>
      <div className="flex flex-wrap items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={!page || isFetching} onClick={() => changePage(page - 1)}>Previous changes</Button><span className="text-xs">Change page {page + 1} of {pages} · {viewed.size} viewed</span><Button type="button" size="sm" variant="outline" disabled={page + 1 >= pages || isFetching} onClick={() => changePage(page + 1)}>Next changes</Button></div>
      {complete && <p className="text-xs text-muted-foreground">Every page of this preview is available for your approval.</p>}
    </>}
  </section>;
}

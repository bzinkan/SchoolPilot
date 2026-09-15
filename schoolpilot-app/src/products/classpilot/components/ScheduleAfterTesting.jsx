const EMPTY = [];
const countText = count => Number.isSafeInteger(count) && count >= 0 ? `${count} ${count === 1 ? 'student' : 'students'}` : 'Student count unavailable';

// Render only the server's roster partition for this exact review/date. Missing
// data never becomes an inferred destination, free period, or zero-student result.
export default function ScheduleAfterTesting({ data, pending = false, name, date, classes = EMPTY, testingBlocks = EMPTY, compact = false }) {
  const ready = data?.status === 'ready' && Array.isArray(data.allocations);
  const state = pending ? 'pending' : ready ? 'ready' : 'unavailable';
  const classNames = ids => ids.map(id => classes.find(row => (row.classId || row.id) === id)?.name || 'Class details unavailable').join(', ');
  const blockNames = ids => ids.map(id => testingBlocks.find(row => (row.blockId || row.id) === id)?.name || 'Testing block details unavailable').join(', ');
  const describe = allocation => {
    const when = allocation.at ? ` at ${allocation.at}` : '';
    const names = allocation.classNames?.length ? allocation.classNames.join(', ') : classNames(allocation.classIds || EMPTY);
    if (allocation.kind === 'class') return `${names || 'Class details unavailable'}${when}`;
    if (allocation.kind === 'gap') return `Gap until ${names || 'the next class'}${when}`;
    if (allocation.kind === 'none') return 'No later class scheduled';
    if (allocation.kind === 'multiple') return `Multiple classes need review: ${names || 'class details unavailable'}${when}`;
    if (allocation.kind === 'continuing_testing') return `Continue testing: ${(allocation.blockNames?.length ? allocation.blockNames.join(', ') : blockNames(allocation.blockIds || EMPTY)) || 'testing details unavailable'}${when}`;
    return 'Next schedule unavailable';
  };
  if (compact) return <p data-after-testing-summary data-after-testing-status={state} className="px-3 pb-2 text-[11px] text-muted-foreground"><span className="font-medium">After testing: </span>{state === 'pending' ? 'Checking this draft…' : state === 'unavailable' ? 'Unavailable — open block to review' : <>{data.allocations.slice(0, 2).map((allocation, index) => <span key={index}>{index ? '; ' : ''}{countText(allocation.studentCount)} · {describe(allocation)}</span>)}{data.studentCount === 0 && data.allocations.length === 0 ? 'No students in this testing group' : ''}{data.allocations.length > 2 ? '; more in block details' : ''}</>}</p>;
  return <section aria-label={`After testing for ${name}`} data-after-testing-status={state} data-after-testing-date={date} className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
    <h5 className="font-semibold">After testing</h5>
    {state === 'pending' ? <p role="status">After testing is being checked for this draft.</p> : state === 'unavailable' ? <p>After testing is unavailable. Refresh the schedule check before relying on a next class.</p> : <>
      <p>{countText(data.studentCount)} in this testing group · {date}</p>
      {data.allocations.map((allocation, index) => <div key={index} data-after-testing-kind={allocation.kind} className="space-y-1"><p>{countText(allocation.studentCount)} · {describe(allocation)}</p>{allocation.staff?.length > 0 && <p className="text-muted-foreground">{allocation.staff.map(person => person.name).join(', ')}</p>}</div>)}
      {data.studentCount === 0 && data.allocations.length === 0 && <p>No students in this testing group.</p>}
    </>}
    <p className="text-muted-foreground">Schedule preview only. Class rosters and teacher assignments stay in place.</p>
  </section>;
}

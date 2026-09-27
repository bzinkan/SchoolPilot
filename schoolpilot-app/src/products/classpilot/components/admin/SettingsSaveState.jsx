import { useState } from 'react';
import { Button } from '../../../../components/ui/button';

const display = value => Array.isArray(value) ? value.join(', ') || 'None' : typeof value === 'boolean' ? value ? 'On' : 'Off' : value === null || value === undefined || value === '' ? 'None' : String(value);

export default function SettingsSaveState({ editor, labels, saveLabel, version = 'version', invalid = false, formatValue = (_field, value) => display(value) }) {
  const [compare, setCompare] = useState(false);
  const hasLatest = editor.conflict && editor.conflict[version] !== undefined;
  return <div className="space-y-3">
    {editor.conflict && <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <p>These settings changed elsewhere. Your draft is still here. Compare the values before saving again.</p>
      {hasLatest ? <><Button type="button" variant="outline" size="sm" onClick={() => setCompare(value => !value)}>{compare ? 'Hide comparison' : 'Compare changes'}</Button>
        {compare && <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Setting</th><th className="p-2">Your draft</th><th className="p-2">Saved now</th></tr></thead><tbody>{Object.entries(labels).map(([field, label]) => <tr key={field} className="border-t"><th className="p-2 font-medium">{label}</th><td className="max-w-64 break-words p-2">{formatValue(field, editor.draft[field])}</td><td className="max-w-64 break-words p-2">{formatValue(field, editor.conflict[field])}</td></tr>)}</tbody></table></div>}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => editor.acceptConflict(false)}>Use latest saved values</Button><Button type="button" variant="outline" size="sm" onClick={() => editor.acceptConflict(true)}>Keep my draft</Button></div>
      </> : <Button type="button" variant="outline" onClick={editor.loadConflict} disabled={editor.busy}>Load latest values to compare</Button>}
    </div>}
    {editor.error && <p role="alert" className="text-sm text-destructive">{editor.error}</p>}
    {editor.notice && <p role="status" className="text-sm text-muted-foreground">{editor.notice}</p>}
    <div className="flex flex-wrap items-center gap-3"><Button type="button" onClick={editor.submit} disabled={editor.busy || !editor.dirty || Boolean(editor.conflict) || invalid}>{editor.busy ? 'Saving…' : saveLabel}</Button>
      {editor.dirty && <><Button type="button" variant="ghost" onClick={editor.discard} disabled={editor.busy}>Discard draft</Button><span className="text-xs text-muted-foreground">Unsaved changes</span></>}
    </div>
  </div>;
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Download } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { myDeskApi } from '../lib/myDesk';
import { myDeskKeys } from '../lib/myDeskModel';

export default function MyDeskAttachment({ schoolId, viewerId, noteId, attachment }) {
  const content = useQuery({ queryKey: myDeskKeys.attachment(schoolId, viewerId, noteId, attachment.id),
    queryFn: ({ signal }) => myDeskApi(schoolId, signal).content(noteId, attachment.id),
    staleTime: 0, gcTime: 0, retry: false, refetchOnMount: 'always' });
  const [object, setObject] = useState(null);
  useEffect(() => {
    if (!(content.data instanceof Blob)) return;
    const url = URL.createObjectURL(content.data);
    // A blob belongs to exactly this fetched response and is never persisted.
    const timer = setTimeout(() => setObject({ blob: content.data, url }), 0);
    return () => { clearTimeout(timer); URL.revokeObjectURL(url); };
  }, [content.data]);
  const url = object && object.blob === content.data ? object.url : null;
  if (content.isError) return <div className="mydesk-file-error" role="alert">Could not load {attachment.originalFilename}. <Button variant="link" onClick={() => content.refetch()}>Retry</Button></div>;
  if (!url) return <p role="status" className="text-sm text-muted-foreground">Loading attachment…</p>;
  return <div className="mydesk-attachment">
    {attachment.contentType.startsWith('image/') ? <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.originalFilename}`}><img src={url} alt={attachment.originalFilename} loading="lazy" /></a> : <FileText aria-hidden="true" className="size-8 text-muted-foreground" />}
    <a className="mydesk-file-link" href={url} download={attachment.originalFilename}><Download className="size-4 shrink-0" aria-hidden="true" /><span>{attachment.originalFilename}</span></a>
  </div>;
}

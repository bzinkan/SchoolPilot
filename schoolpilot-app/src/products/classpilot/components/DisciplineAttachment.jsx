import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { disciplineApi, disciplineKeys } from '../lib/discipline';

export default function DisciplineAttachment({ access, recordId, versionId, attachment }) {
  const { schoolId, viewerId } = access;
  const content = useQuery({ queryKey: disciplineKeys.attachment(schoolId, viewerId, recordId, versionId, attachment.id),
    queryFn: ({ signal }) => disciplineApi(schoolId, signal).content(recordId, versionId, attachment.id),
    retry: false, staleTime: 0, gcTime: 0, refetchOnMount: 'always' });
  const [object, setObject] = useState(null);
  useEffect(() => {
    if (content.isError || !(content.data instanceof Blob)) return;
    const url = URL.createObjectURL(content.data);
    const timer = setTimeout(() => setObject({ blob: content.data, url }), 0);
    return () => { clearTimeout(timer); URL.revokeObjectURL(url); };
  }, [content.data, content.isError]);
  const url = !content.isError && object && object.blob === content.data ? object.url : null;
  const label = attachment.filename || 'Submitted form';
  if (content.isError) return <p role="alert">This form could not be opened. <Button variant="link" onClick={() => content.refetch()}>Retry</Button></p>;
  if (!url) return <p role="status">Loading submitted form…</p>;
  return <figure className="discipline-attachment">
    {attachment.contentType?.startsWith('image/') ? <img src={url} alt={label} /> : <iframe title={label} src={url} />}
    <figcaption><a href={url} download={label}>Download {label}</a></figcaption>
  </figure>;
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { myDeskApi } from '../lib/myDesk';
import { myDeskKeys, myDeskError } from '../lib/myDeskModel';
import { clipRegion } from '../lib/importReviewModel';

export function ImportConfirm({ request, onClose }) {
  return <AlertDialog open={Boolean(request)} onOpenChange={open => { if (!open) onClose(); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{request?.title}</AlertDialogTitle><AlertDialogDescription>{request?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep reviewing</AlertDialogCancel><AlertDialogAction onClick={() => { const action = request?.action; onClose(); action?.(); }}>{request?.label || 'Continue'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}

export function ImportImage({ access, importId, assetId, alt, children, className = '', region, dimensions, onReady }) {
  const [url, setUrl] = useState(null);
  const query = useQuery({ queryKey: myDeskKeys.importAsset(access.schoolId, access.viewerId, importId, assetId), queryFn: ({ signal }) => myDeskApi(access.schoolId, signal).importContent(importId, assetId), enabled: Boolean(assetId), gcTime: 0, staleTime: Infinity, retry: false });
  useEffect(() => {
    if (!query.data || query.isError) return;
    const next = URL.createObjectURL(query.data); const timer = setTimeout(() => setUrl(next), 0);
    return () => { clearTimeout(timer); URL.revokeObjectURL(next); setUrl(null); };
  }, [query.data, query.isError]);
  useEffect(() => { onReady?.(assetId, Boolean(url && !query.isError)); }, [assetId, url, query.isError, onReady]);
  if (!assetId) return <p className="import-image-status">Form image is being prepared.</p>;
  if (query.isError) return <div role="alert"><p>{myDeskError(query.error)}</p><Button variant="outline" onClick={() => query.refetch()}>Retry image</Button></div>;
  const crop = region && clipRegion(region), width = dimensions?.width || 1, height = dimensions?.height || 1;
  const rotatedWidth = crop?.rotation % 180 ? height : width, rotatedHeight = crop?.rotation % 180 ? width : height;
  const transform = crop?.rotation === 90 ? `translate(${height} 0) rotate(90)` : crop?.rotation === 180 ? `translate(${width} ${height}) rotate(180)` : crop?.rotation === 270 ? `translate(0 ${width}) rotate(270)` : undefined;
  return <div className={`import-image ${className}`}>{url && !query.isError ? <>{crop ? <svg role="img" aria-label={alt} viewBox={`${crop.x * rotatedWidth} ${crop.y * rotatedHeight} ${crop.width * rotatedWidth} ${crop.height * rotatedHeight}`} style={{ width: '100%', display: 'block', overflow: 'hidden' }}><title>{alt}</title><g transform={transform}><image href={url} width={width} height={height} /></g></svg> : <img src={url} alt={alt} draggable={false} />}{children}</> : <p role="status">Loading private image…</p>}</div>;
}

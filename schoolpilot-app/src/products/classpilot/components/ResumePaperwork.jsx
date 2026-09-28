import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { myDeskApi } from '../lib/myDesk';
import { myDeskKeys } from '../lib/myDeskModel';
import { paperworkSummaryLabels } from '../lib/importReviewModel';
import { withDisciplineEntry } from '../lib/disciplineNavigation';
import { useAdminNavigation } from '../hooks/useAdminNavigation';
import '../imports.css';

export default function ResumePaperwork({ access, destination }) {
  const { navigate } = useAdminNavigation(); const [params] = useSearchParams(); const location = useLocation();
  const query = useQuery({ queryKey: myDeskKeys.importSummary(access.schoolId, access.viewerId, destination),
    queryFn: ({ signal }) => myDeskApi(access.schoolId, signal).importSummary(destination),
    enabled: Boolean(access.schoolId && access.viewerId && access.importsEnabled !== false),
    staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: 'always',
    refetchInterval: query => query.state.data?.summary?.processing || query.state.data?.summary?.uploading ? 15_000 : 60_000 });
  const labels = query.isError ? [] : paperworkSummaryLabels(query.data?.summary);
  const path = withDisciplineEntry(`/classpilot/my-desk/imports?destination=${destination}&view=library`, params);
  return <div className="import-resume-entry"><Button variant="outline" onClick={() => navigate(path, { state: { returnTo: `${location.pathname}${location.search}`, returnState: location.state } })}><FolderOpen aria-hidden="true" className="size-4" />Resume paperwork</Button>
    {labels.length > 0 && <span className="import-resume-status" role="status">{labels.join(' · ')}</span>}
    {query.isError && <span className="import-resume-status" role="status">Status unavailable. Open paperwork to try again.</span>}
  </div>;
}

import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';

import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { useToast } from '../../../hooks/use-toast';
import { apiRequest } from '../../../lib/queryClient';
import api from '../../../shared/utils/api';

export default function SessionMonitoringReportDialog({ target, onClose }) {
  const { toast } = useToast();
  const {
    data: sessionReport,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['/api/classpilot/teaching-sessions/report', target?.id],
    queryFn: () => apiRequest(
      'GET',
      `/classpilot/teaching-sessions/${encodeURIComponent(target.id)}/report`,
    ),
    enabled: !!target?.id,
    retry: false,
    refetchInterval: (query) => query.state.data?.state === 'pending' ? 5000 : false,
  });

  const downloadEvents = async () => {
    if (!target?.id) return;
    try {
      const response = await api.get(
        `/classpilot/teaching-sessions/${encodeURIComponent(target.id)}/events/export.csv`,
        { responseType: 'blob' },
      );
      const blobUrl = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `ClassPilot_${target.name.replace(/[^a-z0-9_-]+/gi, '_')}_Monitoring.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (downloadError) {
      toast({
        variant: 'destructive',
        title: 'Could not export monitoring activity',
        description: downloadError.response?.data?.error || downloadError.message,
      });
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl" data-testid="dialog-session-monitoring-report">
        <DialogHeader>
          <DialogTitle>{target?.name} — Session Summary</DialogTitle>
          <DialogDescription>
            Observed browser telemetry and Monitoring coverage. Gaps identify missing telemetry only; they do not establish a cause or intentional behavior.
          </DialogDescription>
        </DialogHeader>

        {(isLoading || sessionReport?.state === 'pending') && (
          <div className="flex items-center gap-3 rounded-lg border p-4 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Finalizing the immutable report after the 30-second settlement window…
          </div>
        )}
        {(error || sessionReport?.state === 'failed') && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            The Session Summary could not be generated. No “No activity” conclusion or summary email will be sent.
          </div>
        )}
        {sessionReport?.state === 'ready' && sessionReport.report && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Students</p><p className="text-xl font-semibold">{sessionReport.report.totals.roster}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Complete</p><p className="text-xl font-semibold">{sessionReport.report.totals.complete}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Partial</p><p className="text-xl font-semibold">{sessionReport.report.totals.partial}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">No telemetry</p><p className="text-xl font-semibold">{sessionReport.report.totals.none}</p></div>
            </div>
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr><th className="p-2 text-left">Student</th><th className="p-2 text-left">Status</th><th className="p-2 text-right">Coverage</th><th className="p-2 text-right">Gap</th></tr>
                </thead>
                <tbody>
                  {sessionReport.report.students.map((student) => (
                    <tr key={student.studentId} className="border-t">
                      <td className="p-2 font-medium">{student.studentName}</td>
                      <td className="p-2"><Badge variant="outline">{student.status.replace(/_/g, ' ')}</Badge></td>
                      <td className="p-2 text-right">{student.coveragePercent == null ? '—' : `${student.coveragePercent}%`}</td>
                      <td className="p-2 text-right">{Math.round(student.gapSeconds / 60)}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          {sessionReport?.state === 'ready' && (
            <Button variant="outline" onClick={() => void downloadEvents()}>
              <Download className="mr-2 h-4 w-4" /> Export Monitoring CSV
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

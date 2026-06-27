import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Clock,
  ExternalLink,
  FileWarning,
  GitBranch,
  Lock,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { ThemeToggle } from '../../components/ThemeToggle';
import api from '../../shared/utils/api';

const TABS = [
  ['overview', 'Overview'],
  ['approvals', 'Approvals'],
  ['gaps', 'Evidence Gaps'],
  ['controls', 'Controls'],
  ['security', 'Security Reports'],
  ['claims', 'Claims/Risks'],
];

const STATUS_STYLES = {
  ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  in_progress: 'border-sky-200 bg-sky-50 text-sky-700',
  action_required: 'border-amber-200 bg-amber-50 text-amber-700',
  unavailable: 'border-slate-200 bg-slate-50 text-slate-600',
};

const CONTROL_STATUS_STYLES = {
  Ready: 'bg-emerald-100 text-emerald-700',
  Operating: 'bg-emerald-100 text-emerald-700',
  Implementing: 'bg-sky-100 text-sky-700',
  Planned: 'bg-slate-100 text-slate-600',
  Exception: 'bg-amber-100 text-amber-700',
};

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function statusLabel(value) {
  if (value === 'action_required') return 'Action required';
  if (value === 'in_progress') return 'In progress';
  if (value === 'ready') return 'Ready';
  return 'Unavailable';
}

function statusIcon(value) {
  if (value === 'ready') return <CheckCircle2 className="h-4 w-4" />;
  if (value === 'action_required') return <AlertTriangle className="h-4 w-4" />;
  if (value === 'in_progress') return <Clock className="h-4 w-4" />;
  return <XCircle className="h-4 w-4" />;
}

function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function EmptyState({ text }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function MetricTile({ icon, label, value, detail, tone = 'slate' }) {
  const IconComponent = icon;
  const toneClass = {
    emerald: 'text-emerald-600 bg-emerald-50',
    amber: 'text-amber-600 bg-amber-50',
    red: 'text-red-600 bg-red-50',
    sky: 'text-sky-600 bg-sky-50',
    slate: 'text-slate-600 bg-slate-50',
  }[tone] || 'text-slate-600 bg-slate-50';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
          {detail && <p className="mt-2 truncate text-xs text-slate-500">{detail}</p>}
        </div>
        <span className={`rounded-lg p-2 ${toneClass}`}>
          <IconComponent className="h-5 w-5" />
        </span>
      </div>
    </div>
  );
}

function SourceNotice({ data }) {
  const unavailable = [];
  if (data?.localDocs?.status === 'unavailable') unavailable.push('SOC 2 docs');
  if (data?.github?.issue?.status === 'unavailable') unavailable.push('approval issue');
  if (data?.github?.actions?.status === 'unavailable') unavailable.push('workflow runs');
  if (data?.github?.security?.codeScanning?.status === 'unavailable') unavailable.push('code scanning');
  if (data?.github?.security?.secretScanning?.status === 'unavailable') unavailable.push('secret scanning');
  if (unavailable.length === 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      Partial data: {unavailable.join(', ')} unavailable.
    </div>
  );
}

function LinkButton({ href, children }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

function ApprovalCard({ item, onCopy, copiedCommand }) {
  const approveCopied = copiedCommand === item.approveCommand;
  const rejectCopied = copiedCommand === item.rejectCommand;
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="break-all font-mono text-xs font-semibold text-slate-900">{item.approvalId}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge className="bg-slate-100 text-slate-700">{item.controlId || 'No control'}</Badge>
            <Badge className="bg-sky-100 text-sky-700">{item.decisionType || 'decision'}</Badge>
            {item.expiresAt && item.expiresAt !== 'not_applicable' && (
              <Badge className="bg-amber-100 text-amber-700">Expires {item.expiresAt}</Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onCopy(item.approveCommand)}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
          >
            <Clipboard className="h-3.5 w-3.5" />
            {approveCopied ? 'Copied' : 'Copy approve'}
          </button>
          <button
            type="button"
            onClick={() => onCopy(item.rejectCommand)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            <Clipboard className="h-3.5 w-3.5" />
            {rejectCopied ? 'Copied' : 'Copy reject'}
          </button>
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
        {(item.evidencePointers || []).map((pointer) => (
          <div key={`${item.approvalId}-${pointer.label}`} className="min-w-0 rounded-md bg-slate-50 px-3 py-2">
            <p className="font-semibold text-slate-500">{pointer.label}</p>
            <p className="mt-1 break-all font-mono text-slate-700">{pointer.location}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function GapCard({ gap }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="break-all font-mono text-xs font-semibold text-slate-900">{gap.approvalId}</p>
        <Badge className="bg-amber-100 text-amber-700">Not ready</Badge>
      </div>
      <p className="mt-2 text-sm text-slate-600">{gap.reason || 'Required evidence is missing.'}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {(gap.requiredEvidence || []).map((item) => (
          <div key={`${gap.approvalId}-${item.label}`} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs">
            <p className="font-semibold text-slate-700">{item.label}</p>
            <p className="mt-1 text-amber-700">{item.status || 'missing'}</p>
            {item.location && <p className="mt-1 break-all font-mono text-slate-500">{item.location}</p>}
          </div>
        ))}
      </div>
    </article>
  );
}

function ControlsTable({ rows }) {
  if (!rows?.length) return <EmptyState text="No controls available." />;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Control</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Owner</th>
            <th className="px-4 py-3">Next review</th>
            <th className="px-4 py-3">Impact</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id} className="align-top">
              <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">{row.id}</td>
              <td className="px-4 py-3">
                <Badge className={CONTROL_STATUS_STYLES[row.status] || 'bg-slate-100 text-slate-600'}>{row.status}</Badge>
              </td>
              <td className="px-4 py-3 text-slate-700">{row.owner || '-'}</td>
              <td className="px-4 py-3 text-slate-600">{row.nextReviewDue || '-'}</td>
              <td className="max-w-md px-4 py-3 text-slate-600">{row.automationImpact || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimpleRows({ rows, emptyText, columns }) {
  if (!rows?.length) return <EmptyState text={emptyText} />;
  return (
    <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {rows.map((row) => (
        <div key={row.id || row.approvalId || row.url || row.claim} className="grid gap-2 px-4 py-3 text-sm lg:grid-cols-[180px_1fr_auto]">
          <div>
            <p className="break-all font-mono text-xs font-semibold text-slate-900">{row.id || row.approvalId || row.rule || row.source}</p>
            {row.priority && <p className="mt-1 text-xs text-slate-500">{row.priority}</p>}
          </div>
          <div className="min-w-0 text-slate-700">
            <p className="break-words">{columns.summary(row)}</p>
            {columns.detail && <p className="mt-1 break-words text-xs text-slate-500">{columns.detail(row)}</p>}
          </div>
          <div className="flex items-start justify-start lg:justify-end">
            {columns.action?.(row)}
          </div>
        </div>
      ))}
    </div>
  );
}

function SecurityPanel({ security }) {
  const code = security?.codeScanning;
  const secrets = security?.secretScanning;
  const codeData = code?.data || {};
  const secretData = secrets?.data || {};
  const rows = [...(codeData.sample || []), ...(secretData.sample || [])];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <MetricTile icon={FileWarning} label="Code scanning" value={code?.status === 'available' ? formatNumber(codeData.count) : 'Unavailable'} detail="Open alerts" tone={codeData.count ? 'amber' : 'emerald'} />
        <MetricTile icon={Lock} label="Secret scanning" value={secrets?.status === 'available' ? formatNumber(secretData.count) : 'Unavailable'} detail="Open alerts" tone={secretData.count ? 'red' : 'emerald'} />
      </div>
      <SimpleRows
        rows={rows}
        emptyText="No security alerts returned."
        columns={{
          summary: (row) => row.rule || 'Security alert',
          detail: (row) => `${row.severity || 'unknown'} / ${row.state || 'open'}`,
          action: (row) => <LinkButton href={row.url}>Open</LinkButton>,
        }}
      />
    </div>
  );
}

export default function Soc2() {
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [resyncing, setResyncing] = useState(false);
  const [resyncResult, setResyncResult] = useState(null);
  const [copiedCommand, setCopiedCommand] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/super-admin/soc2/readiness');
      setData(res.data);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load SOC 2 readiness.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = window.setInterval(loadData, 30_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadData]);

  const handleResync = async () => {
    setResyncing(true);
    setError('');
    try {
      const res = await api.post('/super-admin/soc2/resync');
      setResyncResult(res.data);
      await loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Unable to queue SOC 2 resync.');
    } finally {
      setResyncing(false);
    }
  };

  const copyCommand = async (command) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(''), 2000);
    } catch {
      setError('Could not copy command.');
    }
  };

  const counts = data?.overall?.counts || {};
  const status = data?.overall?.status || 'unavailable';
  const pendingApprovals = data?.github?.issue?.data?.pendingApprovals || [];
  const readinessGaps = data?.github?.issue?.data?.readinessGaps || [];
  const decisions = data?.github?.issue?.data?.recordedDecisions || [];
  const issue = data?.github?.issue?.data?.issue;
  const latestRun = data?.github?.actions?.data?.latestRun;
  const openRemediations = data?.localDocs?.openRemediations || [];
  const claimsNeedingEvidence = data?.localDocs?.claimsNeedingEvidence || [];

  const statusClass = STATUS_STYLES[status] || STATUS_STYLES.unavailable;
  const controlStatusRows = useMemo(() => Object.entries(data?.localDocs?.controlsByStatus || {}), [data]);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">SOC 2 Readiness</h1>
            <Badge className={`${statusClass} border`}>
              <span className="mr-1">{statusIcon(status)}</span>
              {statusLabel(status)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {data?.overall?.summary || 'Loading readiness data.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setAutoRefresh((value) => !value)}
            className={`rounded-lg border px-3 py-2 text-sm font-medium ${autoRefresh ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600'}`}
          >
            Auto-refresh {autoRefresh ? 'on' : 'off'}
          </button>
          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleResync}
            disabled={resyncing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            <RotateCw className={`h-4 w-4 ${resyncing ? 'animate-spin' : ''}`} />
            {resyncing ? 'Queueing' : 'Resync'}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {resyncResult && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          <span>Resync queued at {formatTime(resyncResult.queuedAt)}.</span>
          <LinkButton href={resyncResult.workflowUrl}>Workflow</LinkButton>
        </div>
      )}
      <SourceNotice data={data} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricTile icon={ShieldCheck} label="Readiness" value={`${data?.overall?.readinessPercent ?? 0}%`} detail={`${formatNumber(counts.readyControls)} of ${formatNumber(counts.controls)} controls ready`} tone="sky" />
        <MetricTile icon={Clipboard} label="Pending approvals" value={formatNumber(counts.pendingApprovals)} detail={issue ? `Issue #${issue.number}` : 'Approval issue'} tone={counts.pendingApprovals ? 'amber' : 'emerald'} />
        <MetricTile icon={AlertTriangle} label="Evidence gaps" value={formatNumber(counts.readinessGaps)} detail="Blocked approvals" tone={counts.readinessGaps ? 'amber' : 'emerald'} />
        <MetricTile icon={GitBranch} label="Decisions" value={formatNumber(counts.completedDecisions)} detail={`${formatNumber(counts.suppressedCompletedDecisions)} suppressed`} tone="slate" />
        <MetricTile icon={FileWarning} label="Open remediation" value={formatNumber(counts.openRemediations)} detail={`${formatNumber(counts.claimsNeedingEvidence)} claims need evidence`} tone={counts.openRemediations ? 'sky' : 'emerald'} />
        <MetricTile icon={Lock} label="Security alerts" value={formatNumber(counts.securityAlerts)} detail={`${formatNumber(counts.secretScanningAlerts)} secret alerts`} tone={counts.securityAlerts ? 'red' : 'emerald'} />
      </div>

      <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span>Updated {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '-'}</span>
          <span>Generated {formatTime(data?.generatedAt)}</span>
          {issue && <LinkButton href={issue.url}>Approval issue</LinkButton>}
          {latestRun && <LinkButton href={latestRun.url}>Latest CI</LinkButton>}
        </div>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-900'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <EmptyState text="Loading SOC 2 readiness..." />
      ) : (
        <>
          {tab === 'overview' && (
            <div className="grid gap-5 xl:grid-cols-[1fr_0.8fr]">
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase text-slate-500">Action queue</h2>
                {pendingApprovals.length ? (
                  pendingApprovals.slice(0, 4).map((item) => (
                    <ApprovalCard key={item.approvalId} item={item} onCopy={copyCommand} copiedCommand={copiedCommand} />
                  ))
                ) : (
                  <EmptyState text="No pending approvals." />
                )}
              </section>
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase text-slate-500">Operating picture</h2>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="space-y-3">
                    {controlStatusRows.length === 0 ? (
                      <p className="text-sm text-slate-500">No control status data.</p>
                    ) : (
                      controlStatusRows.map(([key, value]) => (
                        <div key={key} className="flex items-center justify-between gap-3">
                          <Badge className={CONTROL_STATUS_STYLES[key] || 'bg-slate-100 text-slate-600'}>{key}</Badge>
                          <span className="text-sm font-semibold text-slate-900">{formatNumber(value)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <h3 className="font-semibold text-slate-900">Recent decisions</h3>
                  <div className="mt-3 space-y-2">
                    {decisions.slice(0, 5).length ? decisions.slice(0, 5).map((decision) => (
                      <div key={`${decision.approvalId}-${decision.createdAt}`} className="text-xs">
                        <p className="break-all font-mono font-semibold text-slate-800">{decision.approvalId}</p>
                        <p className="mt-1 text-slate-500">{decision.decision} by @{decision.actor} at {formatTime(decision.createdAt)}</p>
                      </div>
                    )) : <p className="text-sm text-slate-500">No recorded decisions returned.</p>}
                  </div>
                </div>
              </section>
            </div>
          )}

          {tab === 'approvals' && (
            <section className="space-y-3">
              {pendingApprovals.length ? pendingApprovals.map((item) => (
                <ApprovalCard key={item.approvalId} item={item} onCopy={copyCommand} copiedCommand={copiedCommand} />
              )) : <EmptyState text="No pending approvals." />}
            </section>
          )}

          {tab === 'gaps' && (
            <section className="space-y-3">
              {readinessGaps.length ? readinessGaps.map((gap) => (
                <GapCard key={gap.approvalId} gap={gap} />
              )) : <EmptyState text="No readiness gaps." />}
            </section>
          )}

          {tab === 'controls' && <ControlsTable rows={data?.localDocs?.controls || []} />}

          {tab === 'security' && <SecurityPanel security={data?.github?.security} />}

          {tab === 'claims' && (
            <div className="grid gap-5 xl:grid-cols-2">
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase text-slate-500">Open remediation</h2>
                <SimpleRows
                  rows={openRemediations}
                  emptyText="No open remediation items."
                  columns={{
                    summary: (row) => row.gap || row.area,
                    detail: (row) => `${row.status || 'Unknown'} / ${row.evidenceNeeded || 'No evidence note'}`,
                  }}
                />
              </section>
              <section>
                <h2 className="mb-3 text-sm font-semibold uppercase text-slate-500">Claims needing evidence</h2>
                <SimpleRows
                  rows={claimsNeedingEvidence}
                  emptyText="No claims need evidence."
                  columns={{
                    summary: (row) => row.claim || row.source,
                    detail: (row) => `${row.status || 'Unknown'} / ${row.action || 'No action note'}`,
                  }}
                />
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Gauge,
  RadioTower,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { ThemeToggle } from '../../components/ThemeToggle';
import api from '../../shared/utils/api';

const CATEGORIES = [
  'fatal_process_error',
  'api_error',
  'client_error',
  'scheduler_failure',
  'email_failure',
  'websocket_error',
  'security_event',
  'database_connectivity',
  'health_failure',
  'browser_runtime_error',
  'extension_runtime_error',
];

const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const RANGES = [
  ['15m', '15m'],
  ['1h', '1h'],
  ['6h', '6h'],
  ['24h', '24h'],
  ['7d', '7d'],
];

const STATUS_STYLES = {
  healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  degraded: 'border-amber-200 bg-amber-50 text-amber-700',
  unhealthy: 'border-red-200 bg-red-50 text-red-700',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
};

const PRIORITY_STYLES = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  normal: 'bg-blue-100 text-blue-700',
  low: 'bg-slate-100 text-slate-600',
};

const TAB_ITEMS = [
  ['overview', 'Overview'],
  ['fingerprints', 'Fingerprints'],
  ['events', 'Recent Events'],
  ['runtime', 'Runtime'],
  ['health', 'Health'],
  ['alerting', 'Alerting'],
];

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function statusIcon(status) {
  if (status === 'healthy') return <CheckCircle2 className="h-4 w-4" />;
  if (status === 'unhealthy') return <XCircle className="h-4 w-4" />;
  return <AlertTriangle className="h-4 w-4" />;
}

function statusLabel(status) {
  const safe = status || 'unknown';
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

function Badge({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function StatTile({ icon, label, value, detail }) {
  const IconComponent = icon;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
        </div>
        <IconComponent className="h-5 w-5 text-slate-400" />
      </div>
      {detail && <p className="mt-2 truncate text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function CounterGrid({ counters }) {
  const items = [
    ['Captured', counters?.captured],
    ['Persisted', counters?.persisted],
    ['Dropped', counters?.dropped],
    ['Alerted', counters?.alertAttempted],
    ['Delivered', counters?.alertDelivered],
    ['Failed', counters?.alertFailed],
    ['Cooldown', counters?.cooldownSuppressed],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{formatNumber(value)}</p>
        </div>
      ))}
    </div>
  );
}

function FieldList({ fields }) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value);
  if (entries.length === 0) return <p className="text-sm text-slate-500">No fields</p>;
  return (
    <dl className="space-y-2 text-sm">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="text-xs font-semibold uppercase text-slate-500">{key}</dt>
          <dd className="mt-0.5 break-words font-mono text-xs text-slate-800">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailDrawer({ selected, onClose }) {
  if (!selected) return null;
  const { type, item } = selected;

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" className="absolute inset-0 bg-slate-950/30" onClick={onClose} aria-label="Close details" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase text-slate-500">{type === 'event' ? 'Event Detail' : 'Fingerprint Detail'}</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">{item.category || item.fingerprint}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label="Close details">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {type === 'fingerprint' ? (
            <>
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Fingerprint</p>
                <p className="mt-1 break-all font-mono text-xs text-slate-800">{item.fingerprint}</p>
              </div>
              <CounterGrid counters={item.counters} />
              <FieldList fields={item.fields} />
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Samples</p>
                <div className="mt-2 space-y-2">
                  {(item.samples || []).length === 0 ? (
                    <p className="text-sm text-slate-500">No samples</p>
                  ) : (
                    item.samples.map((sample, index) => (
                      <pre key={`${item.fingerprint}-${index}`} className="whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-50">
                        {sample}
                      </pre>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">Message</p>
                <p className="mt-1 break-words text-sm text-slate-900">{item.message}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-xs font-semibold uppercase text-slate-500">Created</p><p>{formatTime(item.createdAt)}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Status</p><p>{item.statusCode || '-'}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Request</p><p className="break-all font-mono text-xs">{item.requestId || '-'}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">School</p><p className="break-all font-mono text-xs">{item.schoolId || '-'}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Method</p><p>{item.method || '-'}</p></div>
                <div><p className="text-xs font-semibold uppercase text-slate-500">Path</p><p className="break-all font-mono text-xs">{item.path || '-'}</p></div>
              </div>
              <FieldList fields={item.context} />
              {item.stack && (
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-500">Stack</p>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs text-slate-50">
                    {item.stack}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export default function Monitoring() {
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState('1h');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [overview, setOverview] = useState(null);
  const [health, setHealth] = useState(null);
  const [fingerprints, setFingerprints] = useState([]);
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const params = useMemo(() => {
    const value = {};
    if (range) value.range = range;
    if (category) value.category = category;
    if (schoolId.trim()) value.schoolId = schoolId.trim();
    if (query.trim()) value.q = query.trim();
    return value;
  }, [range, category, schoolId, query]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const fingerprintParams = {
        ...(category ? { category } : {}),
        ...(priority ? { priority } : {}),
        ...(query ? { q: query } : {}),
        limit: 100,
      };
      const [overviewRes, healthRes, fingerprintsRes, eventsRes] = await Promise.all([
        api.get('/super-admin/monitoring/overview'),
        api.get('/super-admin/monitoring/health'),
        api.get('/super-admin/monitoring/fingerprints', { params: fingerprintParams }),
        api.get('/super-admin/monitoring/recent-errors', { params }),
      ]);
      setOverview(overviewRes.data);
      setHealth(healthRes.data);
      setFingerprints(fingerprintsRes.data?.fingerprints || []);
      setEvents(eventsRes.data?.errors || []);
      setNextCursor(eventsRes.data?.nextCursor || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load monitoring data');
    } finally {
      setLoading(false);
    }
  }, [category, params, priority, query]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const id = window.setInterval(loadData, 30_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadData]);

  const loadNextEvents = async () => {
    if (!nextCursor) return;
    try {
      const res = await api.get('/super-admin/monitoring/recent-errors', {
        params: { ...params, cursor: nextCursor },
      });
      setEvents((current) => [...current, ...(res.data?.errors || [])]);
      setNextCursor(res.data?.nextCursor || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load more events');
    }
  };

  const submitSearch = (event) => {
    event.preventDefault();
    setQuery(searchInput.trim());
  };

  const status = overview?.status?.status || 'unknown';
  const totals = overview?.stats?.totals || {};
  const runtime = overview?.runtime || {};
  const alerting = overview?.alerting || {};
  const aggregation = overview?.aggregation || {};

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-slate-900">Monitoring</h1>
            <Badge className={`${STATUS_STYLES[status] || STATUS_STYLES.unknown} border`}>
              <span className="mr-1">{statusIcon(status)}</span>
              {statusLabel(status)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">Production alerting, runtime telemetry, and health signals</p>
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
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatTile icon={Activity} label="Captured" value={formatNumber(totals.captured)} detail={`${formatNumber(overview?.stats?.activeFingerprints)} active fingerprints`} />
        <StatTile icon={Send} label="Delivered" value={formatNumber(totals.alertDelivered)} detail={`${formatNumber(totals.alertFailed)} failed deliveries`} />
        <StatTile icon={Database} label="Persisted" value={formatNumber(totals.persisted)} detail={`${formatNumber(totals.persistFailed)} persistence failures`} />
        <StatTile icon={RadioTower} label="Aggregation" value={aggregation.mode || '-'} detail={aggregation.ok === false ? aggregation.degradedReason : 'operational'} />
      </div>

      <div className="mb-5 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex flex-wrap gap-2">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRange(value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${range === value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All categories</option>
            {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={priority} onChange={(event) => setPriority(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">All priorities</option>
            {PRIORITIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <input
            value={schoolId}
            onChange={(event) => setSchoolId(event.target.value)}
            placeholder="School ID"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <form onSubmit={submitSearch} className="flex min-w-0 flex-1">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="ID, request ID, fingerprint, or event ID"
                className="w-full rounded-l-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm"
              />
            </div>
            <button type="submit" className="rounded-r-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
              Search
            </button>
          </form>
        </div>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TAB_ITEMS.map(([value, label]) => (
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

      {loading && !overview ? (
        <EmptyState text="Loading monitoring data..." />
      ) : (
        <>
          {tab === 'overview' && (
            <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
              <section className="rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <h2 className="font-semibold text-slate-900">Top Fingerprints</h2>
                </div>
                <FingerprintTable rows={overview?.topFingerprints || []} onSelect={(item) => setSelected({ type: 'fingerprint', item })} />
              </section>
              <section className="rounded-lg border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <h2 className="font-semibold text-slate-900">Category Summary</h2>
                </div>
                <div className="divide-y divide-slate-100">
                  {(overview?.recentCategorySummary || []).length === 0 ? (
                    <p className="p-4 text-sm text-slate-500">No category activity</p>
                  ) : (
                    overview.recentCategorySummary.map((item) => (
                      <div key={item.category} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3 text-sm">
                        <span className="font-mono text-xs text-slate-700">{item.category}</span>
                        <span className="text-slate-500">{formatNumber(item.count)} captured</span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}

          {tab === 'fingerprints' && (
            <section className="rounded-lg border border-slate-200 bg-white">
              <FingerprintTable rows={fingerprints} onSelect={(item) => setSelected({ type: 'fingerprint', item })} />
            </section>
          )}

          {tab === 'events' && (
            <section className="rounded-lg border border-slate-200 bg-white">
              <EventTable rows={events} onSelect={(item) => setSelected({ type: 'event', item })} />
              {nextCursor && (
                <div className="border-t border-slate-200 p-3 text-center">
                  <button type="button" onClick={loadNextEvents} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                    Load more
                  </button>
                </div>
              )}
            </section>
          )}

          {tab === 'runtime' && (
            <section className="grid gap-4 md:grid-cols-2">
              <RuntimeRow icon={Server} label="Environment" value={runtime.environment} />
              <RuntimeRow icon={Gauge} label="Service" value={runtime.service} />
              <RuntimeRow icon={Clock} label="Started" value={formatTime(runtime.startedAt)} />
              <RuntimeRow icon={Activity} label="Release" value={runtime.release} />
              <RuntimeRow icon={ShieldAlert} label="Instance" value={runtime.instanceId} wide />
            </section>
          )}

          {tab === 'health' && (
            <section className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-slate-900">Health Snapshot</h2>
                    <p className="mt-1 text-sm text-slate-500">Generated {formatTime(health?.generatedAt)}</p>
                  </div>
                  <Badge className={`${STATUS_STYLES[health?.status || 'unknown'] || STATUS_STYLES.unknown} border`}>
                    {statusLabel(health?.status)}
                  </Badge>
                </div>
              </div>
              <HealthChecks checks={health?.checks || {}} />
            </section>
          )}

          {tab === 'alerting' && (
            <section className="space-y-4">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-slate-900">Delivery Health</h2>
                    <p className="mt-1 text-sm text-slate-500">{alerting.degradedReason || 'Configured alert channels are available'}</p>
                  </div>
                  <Badge className={`${alerting.ok ? STATUS_STYLES.healthy : STATUS_STYLES.degraded} border`}>
                    {alerting.ok ? 'Ready' : 'Degraded'}
                  </Badge>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {(alerting.configuredChannels || []).length === 0 ? (
                    <Badge className="bg-slate-100 text-slate-600">No channels configured</Badge>
                  ) : (
                    alerting.configuredChannels.map((channel) => (
                      <Badge key={channel} className="bg-slate-100 text-slate-700">{channel}</Badge>
                    ))
                  )}
                </div>
              </div>
              <CounterGrid counters={totals} />
            </section>
          )}
        </>
      )}

      <DetailDrawer selected={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function RuntimeRow({ icon, label, value, wide }) {
  const IconComponent = icon;
  return (
    <div className={`rounded-lg border border-slate-200 bg-white p-4 ${wide ? 'md:col-span-2' : ''}`}>
      <div className="flex items-start gap-3">
        <IconComponent className="mt-0.5 h-5 w-5 text-slate-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
          <p className="mt-1 break-words font-mono text-sm text-slate-900">{value || '-'}</p>
        </div>
      </div>
    </div>
  );
}

function FingerprintTable({ rows, onSelect }) {
  if (!rows || rows.length === 0) return <EmptyState text="No active fingerprints match the filters." />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Category</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Recent</th>
            <th className="px-4 py-3">Total</th>
            <th className="px-4 py-3">Path/Job</th>
            <th className="px-4 py-3">Last Seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((row) => (
            <tr key={row.fingerprint} onClick={() => onSelect(row)} className="cursor-pointer hover:bg-slate-50">
              <td className="px-4 py-3 font-mono text-xs text-slate-800">{row.category}</td>
              <td className="px-4 py-3"><Badge className={PRIORITY_STYLES[row.priority] || PRIORITY_STYLES.normal}>{row.priority}</Badge></td>
              <td className="px-4 py-3 font-semibold text-slate-900">{formatNumber(row.recentCount)}</td>
              <td className="px-4 py-3 text-slate-600">{formatNumber(row.count)}</td>
              <td className="max-w-sm px-4 py-3">
                <p className="truncate font-mono text-xs text-slate-700">{row.fields?.path || row.fields?.job || '-'}</p>
                {row.fields?.messageType && <p className="mt-1 truncate text-xs text-slate-500">{row.fields.messageType}</p>}
              </td>
              <td className="px-4 py-3 text-slate-600">{formatTime(row.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventTable({ rows, onSelect }) {
  if (!rows || rows.length === 0) return <EmptyState text="No recent events match the filters." />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Time</th>
            <th className="px-4 py-3">Category</th>
            <th className="px-4 py-3">Message</th>
            <th className="px-4 py-3">Path</th>
            <th className="px-4 py-3">School</th>
            <th className="px-4 py-3">Request</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((row) => (
            <tr key={row.id} onClick={() => onSelect(row)} className="cursor-pointer hover:bg-slate-50">
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatTime(row.createdAt)}</td>
              <td className="px-4 py-3 font-mono text-xs text-slate-800">{row.category}</td>
              <td className="max-w-md px-4 py-3"><p className="truncate text-slate-900">{row.message}</p></td>
              <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.path || '-'}</td>
              <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.schoolId || '-'}</td>
              <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.requestId || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HealthChecks({ checks }) {
  const entries = Object.entries(checks).filter(([key]) => key !== 'recentErrors');
  if (entries.length === 0) return <EmptyState text="No health checks available." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {entries.map(([key, value]) => {
        const check = summarizeCheck(key, value);
        return (
          <div key={key} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-slate-900">{key}</h3>
              <Badge className={`${check.ok ? STATUS_STYLES.healthy : STATUS_STYLES.degraded} border`}>
                {check.ok ? 'OK' : 'Degraded'}
              </Badge>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              {Object.entries(check.details).map(([detailKey, detailValue]) => (
                <div key={detailKey} className="grid grid-cols-[120px_1fr] gap-3">
                  <dt className="text-xs font-semibold uppercase text-slate-500">{detailKey}</dt>
                  <dd className="break-words font-mono text-xs text-slate-800">{String(detailValue ?? '-')}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function summarizeCheck(key, value) {
  if (!value || typeof value !== 'object') return { ok: true, details: { value } };
  if (key === 'monitoring') {
    return {
      ok: value.ok !== false && value.aggregation?.ok !== false,
      details: {
        release: value.runtime?.release,
        instance: value.runtime?.instanceId,
        aggregation: value.aggregation?.mode,
        active: value.stats?.activeFingerprints,
      },
    };
  }
  return {
    ok: value.ok !== false,
    details: Object.fromEntries(
      Object.entries(value)
        .filter(([detailKey]) => !['stats', 'runtime'].includes(detailKey))
        .map(([detailKey, detailValue]) => [
          detailKey,
          typeof detailValue === 'object' && detailValue !== null ? JSON.stringify(detailValue) : detailValue,
        ])
    ),
  };
}

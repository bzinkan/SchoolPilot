import { POSTURE_STATUS_LABELS, SECURITY_POSTURE } from './securityPosture';

const PILL_CLASSES = {
  in_place: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  partial: 'border-amber-300 bg-amber-50 text-amber-800',
  planned: 'border-slate-300 bg-slate-100 text-slate-600',
};

function StatusPill({ status, dense }) {
  const size = dense ? 'w-[4.5rem] text-[9.5px] py-px' : 'w-20 text-xs py-0.5';
  return (
    <span className={`inline-block shrink-0 rounded-full border text-center font-semibold ${size} ${PILL_CLASSES[status]}`}>
      {POSTURE_STATUS_LABELS[status]}
    </span>
  );
}

export default function SecurityPostureList({ dense = false }) {
  if (dense) {
    return (
      <div className="columns-1 gap-6 sm:columns-2 print:columns-2">
        {SECURITY_POSTURE.map((section) => (
          <section key={section.title} className="mb-3 break-inside-avoid">
            <h2 className="mb-1 border-b border-slate-200 pb-0.5 text-[12px] font-bold uppercase tracking-wide text-slate-900">
              {section.title}
            </h2>
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.label} className="flex items-start gap-2 text-[11px] leading-snug text-slate-700">
                  <StatusPill status={item.status} dense />
                  <span className="min-w-0 break-words">
                    <strong className="text-slate-900">{item.label}.</strong> {item.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {SECURITY_POSTURE.map((section) => (
        <section key={section.title} className="rounded-lg border border-slate-200 bg-white p-5">
          <h3 className="mb-3 text-lg font-semibold text-slate-900">{section.title}</h3>
          <ul className="space-y-3">
            {section.items.map((item) => (
              <li key={item.label} className="flex items-start gap-3 text-sm text-slate-700">
                <StatusPill status={item.status} />
                <span>
                  <strong className="text-slate-900">{item.label}</strong> — {item.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

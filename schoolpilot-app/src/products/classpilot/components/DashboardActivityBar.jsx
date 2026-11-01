export default function DashboardActivityBar({ bannerRef, title, state, details, status, controls, observer, notices }) {
  return (
    <section ref={bannerRef} tabIndex={-1} aria-label="Class and activity" className="dashboard-activity-bar" data-testid="scheduled-class-banner">
      <div className="dashboard-activity-summary">
        <div className="dashboard-activity-heading" role="status" aria-live="polite" aria-atomic="true">
          <p className="dashboard-activity-title" data-testid="dashboard-activity-title">{title}</p>
          {state ? <span className="dashboard-activity-state">{state}</span> : null}
        </div>
        {details ? <div className="dashboard-activity-details">{details}</div> : null}
        {status ? <div className="dashboard-activity-connection">{status}</div> : null}
      </div>
      <div className="dashboard-activity-actions">
        {controls ? <div className="dashboard-class-actions" data-testid="dashboard-class-actions">{controls}</div> : null}
        {observer}
      </div>
      {notices ? <div className="dashboard-activity-notices">{notices}</div> : null}
    </section>
  );
}

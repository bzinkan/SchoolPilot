import './dashboardHeader.css';

// Navigation and activity share one measured sticky boundary for Class tools.
export default function DashboardHeader({ brand, navigation, account, children }) {
  return (
    <header data-class-tools-navigation className="classpilot-dashboard-header chrome-surface bg-chrome border-b border-chrome-border">
      <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-brand to-brand-strong" aria-hidden="true" />
      <div className="dashboard-header-row" data-testid="dashboard-header-masthead">
        <div className="dashboard-header-brand" data-testid="dashboard-header-brand">{brand}</div>
        <nav className="dashboard-header-navigation" aria-label="Dashboard navigation">{navigation}</nav>
        <div className="dashboard-header-account">{account}</div>
      </div>
      {children}
    </header>
  );
}

export default function KioskOfflineBanner({ isOffline, lastSuccessAt }) {
  if (!isOffline) return null;
  const lastUpdated = lastSuccessAt
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(lastSuccessAt)
    : null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] border-b border-amber-500/70 bg-amber-950 px-4 py-2 text-center text-sm font-medium text-amber-100 shadow-lg"
      role="alert"
      data-testid="kiosk-offline-banner"
    >
      Kiosk is offline. {lastUpdated ? `Showing information last updated at ${lastUpdated}. ` : ''}Retrying automatically.
    </div>
  );
}

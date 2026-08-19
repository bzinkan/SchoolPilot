import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { RuntimeErrorBoundary } from '../src/lib/runtimeTelemetry';
import { Button } from '../src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../src/components/ui/dialog';
import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '../src/components/ui/toast';

export function IntentionalCrash({ active }) {
  if (active) throw new Error('Intentional RuntimeErrorBoundary regression error');
  return null;
}

export function RegressionHarness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const [ackCount, setAckCount] = useState(0);
  const [deliveryStatus, setDeliveryStatus] = useState('idle');
  const [crash, setCrash] = useState(false);

  const dispatchOpenUrl = async () => {
    setDeliveryStatus('sent');
    await Promise.resolve({ ok: true });
    setDialogOpen(false);
    queueMicrotask(() => {
      setDeliveryStatus('completed');
      setAckCount((count) => count + 1);
      setToastOpen(true);
    });
  };

  return (
    <ToastProvider duration={60_000}>
      <main className="min-h-screen bg-background p-8 text-foreground" data-testid="dashboard-sentinel">
        <h1 className="text-2xl font-semibold">ClassPilot command regression harness</h1>
        <p className="mt-2" data-testid="delivery-status">Delivery: {deliveryStatus}</p>
        <p className="mt-1" data-testid="ack-count">Acknowledgements: {ackCount}</p>
        <div className="mt-6 flex gap-3">
          <Button type="button" onClick={() => setDialogOpen(true)} data-testid="open-url-dialog">Open URL</Button>
          <Button type="button" variant="destructive" onClick={() => setCrash(true)} data-testid="trigger-boundary">Trigger boundary</Button>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent data-testid="open-url-dialog-content">
            <DialogHeader>
              <DialogTitle>Open URL on student devices</DialogTitle>
              <DialogDescription>Simulates an HTTP success followed immediately by a WebSocket completion ACK.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="button" onClick={dispatchOpenUrl} data-testid="confirm-open-url">Open URL</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Toast key={ackCount} open={toastOpen} onOpenChange={setToastOpen} data-testid="delivery-toast">
          <div className="grid gap-1">
            <ToastTitle>Acknowledged</ToastTitle>
            <ToastDescription>1 completed. Device acknowledgement received.</ToastDescription>
          </div>
        </Toast>
        <ToastViewport />
        <IntentionalCrash active={crash} />
      </main>
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <RuntimeErrorBoundary>
    <RegressionHarness />
  </RuntimeErrorBoundary>,
);

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '../src/index.css';
import StudentDataDialog from '../src/products/classpilot/components/StudentDataDialog';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 60_000 },
  },
});

function StudentDataRegressionHarness() {
  const [open, setOpen] = useState(true);
  const role = new URLSearchParams(window.location.search).get('role') || 'teacher';

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Student Data regression harness</h1>
      {!open ? (
        <button
          type="button"
          className="mt-4 rounded bg-primary px-3 py-2 text-primary-foreground"
          onClick={() => setOpen(true)}
          data-testid="button-reopen-student-data"
        >
          Reopen Student Data
        </button>
      ) : null}
      {open ? (
        <StudentDataDialog
          open
          schoolId="school-browser"
          viewerId={role === 'school_admin' ? 'admin-browser' : 'teacher-browser'}
          viewerRole={role}
          onOpenChange={setOpen}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <StudentDataRegressionHarness />
  </QueryClientProvider>,
);

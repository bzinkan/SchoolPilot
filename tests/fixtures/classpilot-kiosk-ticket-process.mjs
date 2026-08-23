const mode = process.env.KIOSK_TICKET_PROCESS_MODE;

function finish(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(exitCode));
}

try {
  const service = await import('../../dist/services/classpilotKioskLaunchTicket.js');
  if (mode === 'issue') {
    const issued = await service.issueClasspilotKioskLaunchTicket({
      schoolId: process.env.KIOSK_TICKET_SCHOOL_ID,
      directoryDeviceId: process.env.KIOSK_TICKET_DIRECTORY_ID,
      version: 2,
    });
    finish({
      ok: true,
      ticket: issued.ticket,
      expiresAt: issued.expiresAt.toISOString(),
      expiresInSeconds: issued.expiresInSeconds,
    });
  } else if (mode === 'consume') {
    const continuity = await service.consumeClasspilotKioskLaunchTicket({
      ticket: process.env.KIOSK_TICKET,
      schoolId: process.env.KIOSK_TICKET_SCHOOL_ID,
    });
    finish({ ok: true, continuity });
  } else {
    finish({ ok: false, error: 'unsupported_mode' }, 2);
  }
} catch (error) {
  finish({
    ok: false,
    code: error?.code || null,
    status: error?.status || null,
    message: error?.message || String(error),
  });
}

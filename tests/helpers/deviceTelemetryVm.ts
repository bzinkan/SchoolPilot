/** Adapt existing executable route-slice fixtures to the canonical operation API. */
export function withDeviceTelemetryContext<T extends Record<string, any>>(globals: T): T {
  const req = globals.req ?? {}, res = globals.res;
  return Object.assign(globals, {
    telemetryIdentity: undefined,
    context: {
      payload: req.body ?? {},
      binding: { schoolId: globals.schoolId ?? res?.locals?.schoolId,
        studentId: globals.studentId ?? res?.locals?.studentId,
        studentSessionId: globals.studentSessionId ?? res?.locals?.studentSessionId,
        deviceId: globals.deviceId ?? res?.locals?.deviceId },
      delivery: {
        get finished() { return res?.writableFinished === true; },
        get closed() { return res?.destroyed === true && !res?.writableFinished; },
        onFinished(listener: () => void) { res.once("finish", listener); },
        onClosed(listener: () => void) { res.once("close", listener); },
      },
      reply(status: number, body: Record<string, unknown>) {
        return status === 200 ? res.json(body) : res.status(status).json(body);
      },
    },
  });
}

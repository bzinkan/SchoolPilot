const PREFIX = 'data:image/jpeg;base64,';

// Stamp only the existing synthetic JPEG COM padding. Size and decoder contract
// remain unchanged, while a painted source identifies one exact capture.
export function stampReliabilityFrame(fixture, capturedAt, ordinal) {
  if (!fixture.startsWith(PREFIX)) throw new Error('Reliability frame must be JPEG');
  const bytes = Buffer.from(fixture.slice(PREFIX.length), 'base64');
  const stamp = `CLP_REL_FRAME_V1:${capturedAt}:${ordinal}:END`;
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0 || !Number.isSafeInteger(ordinal) || ordinal < 1
    || stamp.length > 96 || bytes.length < 128 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('Invalid reliability capture identity');
  const start = bytes.length - 98;
  if (!bytes.subarray(start, -2).every(value => value === 0x4c)) throw new Error('Expected synthetic JPEG comment padding');
  bytes.write(stamp, start, 'ascii');
  return PREFIX + bytes.toString('base64');
}

export function readReliabilityFrame(source) {
  if (typeof source !== 'string' || !source.startsWith(PREFIX)) return null;
  const bytes = Buffer.from(source.slice(PREFIX.length), 'base64');
  const match = bytes.subarray(-98, -2).toString('ascii').match(/^CLP_REL_FRAME_V1:(\d{13}):(\d+):END/);
  if (!match) return null;
  const capturedAt = Number(match[1]), ordinal = Number(match[2]);
  return Number.isSafeInteger(capturedAt) && Number.isSafeInteger(ordinal) && ordinal > 0 ? { capturedAt, ordinal } : null;
}

export async function initialReliabilityCommandBurst(bodies, send) {
  if (!Array.isArray(bodies) || bodies.length < 1 || bodies.length > 20) throw new Error('Reliability command burst requires1..20 exact classrooms');
  await Promise.all(bodies.map((body, index) => send(body, index)));
}

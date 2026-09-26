import { broadcastToTeachersLocal } from "./ws-broadcast.js";
import { publishWS } from "./ws-redis.js";

/** A refresh signal only: never includes students, record IDs, or private data. */
export async function announceSharedRecordAccessChanged(schoolId: string): Promise<void> {
  const message = { type: "shared-record-access-changed", schoolId };
  try { broadcastToTeachersLocal(schoolId, message); } catch { /* Focus revalidation remains available. */ }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // publishWS bounds Redis initialization with its signal, but deliberately
    // does not abort an already-sent PUBLISH. Bound our response wait as well.
    await Promise.race([
      publishWS({ kind: "staff", schoolId }, message, { signal: controller.signal }),
      new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 2000); }),
    ]);
  } catch { /* A committed roster change must not become a failed mutation response. */ }
  finally { if (timer) clearTimeout(timer); }
}

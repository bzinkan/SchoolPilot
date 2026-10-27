import { z } from "zod";

const sessionStop = z.object({
  teachingSessionId: z.string().trim().min(1).max(128),
  targetScope: z.literal("class"),
  commandType: z.literal("remove-flight-path"),
  commandPayload: z.object({}).strict(),
  stopAutomaticFlightPath: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
}).strict();

/** The only after-hours exception here is removal of a named class preset. */
export function parseAutomaticFlightPathStopOption(body: unknown): { expectedRevision: number } | undefined {
  if (!body || typeof body !== "object" || !Object.hasOwn(body, "stopAutomaticFlightPath")) return undefined;
  const parsed = sessionStop.safeParse(body);
  if (!parsed.success) throw Object.assign(new Error(
    "Stopping an automatic Flight Path requires its exact class session and revision"
  ), { status: 400, code: "AUTOMATIC_FLIGHT_PATH_STOP_INVALID" });
  return parsed.data.stopAutomaticFlightPath;
}

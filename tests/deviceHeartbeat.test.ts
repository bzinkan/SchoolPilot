import { describe, expect, it, vi } from "vitest";
import {
  buildHeartbeatResponse,
  getPendingMessagesForFirstHeartbeat,
  shouldAcceptHeartbeat,
} from "../src/routes/classpilot/deviceHeartbeat.js";

describe("ClassPilot heartbeat helpers", () => {
  it("rate-limits repeated heartbeats per device", () => {
    const heartbeats = new Map<string, number>();

    expect(shouldAcceptHeartbeat(heartbeats, "device-1", 1_000, 5_000)).toBe(true);
    expect(shouldAcceptHeartbeat(heartbeats, "device-1", 4_000, 5_000)).toBe(false);
    expect(shouldAcceptHeartbeat(heartbeats, "device-1", 6_000, 5_000)).toBe(true);
    expect(heartbeats.get("device-1")).toBe(6_000);
  });

  it("loads missed messages only on the first heartbeat for a device", async () => {
    const deliveredMessagesByDevice = new Map<string, Set<string>>();
    const loadRecentMessages = vi.fn(async () => [
      { id: "msg-1", message: "lock screen" },
      { id: "msg-2", message: "open tab" },
    ]);

    const first = await getPendingMessagesForFirstHeartbeat({
      deliveredMessagesByDevice,
      deviceId: "device-1",
      studentId: "student-1",
      loadRecentMessages,
    });
    const second = await getPendingMessagesForFirstHeartbeat({
      deliveredMessagesByDevice,
      deviceId: "device-1",
      studentId: "student-1",
      loadRecentMessages,
    });

    expect(first).toEqual([
      { id: "msg-1", message: "lock screen" },
      { id: "msg-2", message: "open tab" },
    ]);
    expect(second).toEqual([]);
    expect(loadRecentMessages).toHaveBeenCalledTimes(1);
    expect(deliveredMessagesByDevice.get("device-1")).toEqual(
      new Set(["msg-1", "msg-2"])
    );
  });

  it("builds compact heartbeat responses", () => {
    expect(buildHeartbeatResponse(null)).toEqual({ ok: true, planStatus: "active" });
    expect(buildHeartbeatResponse("trialing", [{ id: "msg-1", message: "hello" }])).toEqual({
      ok: true,
      planStatus: "trialing",
      pendingMessages: [{ id: "msg-1", message: "hello" }],
    });
  });
});

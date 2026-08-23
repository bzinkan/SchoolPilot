import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skipsWebSession } from "../src/app.js";

function request(method: string, path: string) {
  return { method, path };
}

describe("ClassPilot web-session routing", () => {
  it("loads cookie sessions for authenticated staff poll, check-in, and screenshot routes", () => {
    for (const req of [
      request("POST", "/api/classpilot/polls/create"),
      request("GET", "/api/classpilot/polls"),
      request("GET", "/api/classpilot/polls/poll-1/results"),
      request("POST", "/api/classpilot/polls/poll-1/close"),
      request("POST", "/api/classpilot/checkin/request"),
      request("GET", "/api/classpilot/device/screenshot/device-1"),
      request("POST", "/api/polls/create"),
      request("POST", "/api/checkin/request"),
      request("GET", "/api/device/screenshot/device-1"),
    ]) {
      assert.equal(skipsWebSession(req), false, `${req.method} ${req.path}`);
    }
  });

  it("keeps device- and student-token traffic off the web-session pool", () => {
    for (const req of [
      request("POST", "/api/classpilot/polls/poll-1/respond"),
      request("POST", "/api/classpilot/checkin/respond"),
      request("POST", "/api/classpilot/student/raise-hand"),
      request("POST", "/api/classpilot/device/heartbeat"),
      request("POST", "/api/classpilot/device/screenshot"),
      request("GET", "/api/classpilot/device/device-1/students"),
      request("GET", "/api/classpilot/extension/settings"),
      request("POST", "/api/classpilot/kiosk/launch-ticket"),
      request("POST", "/api/classpilot/kiosk/launch-ticket/preflight"),
      request("POST", "/api/polls/poll-1/respond"),
      request("POST", "/api/checkin/respond"),
      request("POST", "/api/device/event"),
    ]) {
      assert.equal(skipsWebSession(req), true, `${req.method} ${req.path}`);
    }
  });

  it("keeps public kiosk polling off the web-session pool without bypassing teacher routes", () => {
    for (const req of [
      request("POST", "/api/passpilot/kiosk/auth"),
      request("POST", "/api/passpilot/kiosk/launch-ticket/redeem"),
      request("POST", "/api/passpilot/kiosk/session"),
      request("POST", "/api/passpilot/kiosk/session/resume"),
      request("GET", "/api/passpilot/kiosk/config"),
      request("GET", "/api/passpilot/kiosk/students"),
      request("GET", "/api/passpilot/kiosk/snapshot"),
      request("POST", "/api/passpilot/kiosk/client-health"),
      request("GET", "/api/kiosk/snapshot"),
      request("POST", "/api/kiosk/launch-ticket/redeem"),
    ]) {
      assert.equal(skipsWebSession(req), true, `${req.method} ${req.path}`);
    }

    for (const req of [
      request("PUT", "/api/passpilot/kiosk/config"),
      request("POST", "/api/passpilot/kiosk/sessions/claim"),
      request("GET", "/api/passpilot/kiosk/sessions/mine"),
      request("PUT", "/api/passpilot/kiosk/sessions/session-1"),
    ]) {
      assert.equal(skipsWebSession(req), false, `${req.method} ${req.path}`);
    }
  });
});

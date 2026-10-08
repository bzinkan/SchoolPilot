import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION,
  prepareClasspilotAiRequestInput,
  type ClasspilotAiRequestInputUnavailableReason,
  type PreparedClasspilotAiRequestInput,
} from "../src/services/classpilotAiRequestInput.js";

const MARKER = "[REDACTED_CREDENTIAL]";

function ready(url: string, title?: string): PreparedClasspilotAiRequestInput {
  const result = prepareClasspilotAiRequestInput(url, title);
  assert.equal(result.kind, "ready", JSON.stringify(result));
  if (result.kind !== "ready") throw new Error("Expected prepared fixture");
  assert.equal(result.policyVersion, CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION);
  return result;
}

function withheld(url: string, title?: string, reason?: ClasspilotAiRequestInputUnavailableReason): void {
  const result = prepareClasspilotAiRequestInput(url, title);
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ["kind", "reasonCode"]);
  if (reason) {
    assert.equal(result.kind === "unavailable" ? result.reasonCode : undefined, reason);
  }
}

describe("ClassPilot browser AI request credential policy", () => {
  it("preserves ordinary observed bytes, email, search text and resource identifiers", () => {
    const url = "HTTPS://Resource.test:8443/Unit%20One?q=a%2Bb+student%40example.test&code=lesson&key=math&id=3&state=unit&q=second#section-2";
    const title = "student@example.test — Tokens and passwords: 100% participation";
    assert.equal(ready(url, title).url, url);
    assert.equal(ready(url, title).title, title);
  });

  it("uses the same existing Unknown placeholder for missing and empty titles", () => {
    assert.equal(ready("https://ordinary.test/lesson").title, "Unknown");
    assert.equal(ready("https://ordinary.test/lesson", "").title, "Unknown");
  });

  it("removes username/password and retains the exact destination authority", () => {
    const result = ready("https://SYNTHETIC_USERNAME:SYNTHETIC_PASSWORD@Resource.test:8443/lesson?q=math#part", "Lesson");
    assert.equal(result.url, "https://Resource.test:8443/lesson?q=math#part");
    assert.equal(result.title, "Lesson");
  });

  it("removes username-only and percent-encoded userinfo", () => {
    assert.equal(ready("https://SYNTHETIC_USER@ordinary.test/lesson").url, "https://ordinary.test/lesson");
    assert.equal(ready("https://SYNTHETIC%255FUSER:SYNTHETIC%255FPASS@ordinary.test/lesson").url, "https://ordinary.test/lesson");
  });

  it("redacts every reviewed explicit query credential without reserializing other bytes", () => {
    for (const key of ["access_token", "id_token", "refresh_token", "oauth_token", "api_key", "apikey", "client_secret", "password", "passwd", "pwd", "authorization"]) {
      const url = `https://ordinary.test/lesson?before=a%2Bb&${key}=SYNTHETIC_CREDENTIAL&after=b+b&&last=&flag`;
      assert.equal(ready(url, "Lesson").url, `https://ordinary.test/lesson?before=a%2Bb&${key}=${MARKER}&after=b+b&&last=&flag`);
    }
  });

  it("redacts complete case-insensitive, hyphen-aliased and twice-decoded field names", () => {
    const url = "https://ordinary.test/lesson?ACCESS-TOKEN=CREDENTIAL_ONE&Access_Token=CREDENTIAL_TWO&a%2563cess%255Ftoken=CREDENTIAL%252FTHREE&xaccess_token=ordinary";
    assert.equal(ready(url, "Lesson").url,
      `https://ordinary.test/lesson?ACCESS-TOKEN=${MARKER}&Access_Token=${MARKER}&a%2563cess%255Ftoken=${MARKER}&xaccess_token=ordinary`);
  });

  it("preserves query ordering and duplicates while replacing each credential value span", () => {
    const url = "https://ordinary.test/lesson?resource=2&access_token=CREDENTIAL_ONE&resource=1&access_token=CREDENTIAL_TWO#chapter";
    assert.equal(ready(url, "Lesson").url,
      `https://ordinary.test/lesson?resource=2&access_token=${MARKER}&resource=1&access_token=${MARKER}#chapter`);
  });

  it("redacts plain key/value fragments without deleting unrelated fragment entries", () => {
    const url = "https://ordinary.test/lesson?unit=math#section=fractions&ACCESS-TOKEN=CREDENTIAL_ONE&note=a%2Bb&password=CREDENTIAL_TWO";
    assert.equal(ready(url, "Lesson").url,
      `https://ordinary.test/lesson?unit=math#section=fractions&ACCESS-TOKEN=${MARKER}&note=a%2Bb&password=${MARKER}`);
  });

  it("keeps unrelated educational, harmful-intent and prevention query context", () => {
    for (const query of ["fraction+practice", "how+to+hurt+myself", "suicide+prevention+and+support"]) {
      const url = `https://ordinary.test/lesson?q=${query}&access_token=SYNTHETIC_CREDENTIAL`;
      assert.equal(ready(url, "Lesson").url,
        `https://ordinary.test/lesson?q=${query}&access_token=${MARKER}`);
    }
  });

  it("redacts empty explicit credential values only when other useful context remains", () => {
    assert.equal(ready("https://ordinary.test/lesson?password=").url, `https://ordinary.test/lesson?password=${MARKER}`);
    withheld("https://ordinary.test/?password=", undefined, "insufficient_context");
  });

  it("withholds sensitive titles, even when the same field could be safely removed from a URL", () => {
    for (const title of [
      "Lesson access_token=SYNTHETIC_CREDENTIAL", "Lesson password: SYNTHETIC_CREDENTIAL",
      "Lesson Authorization: Bearer SYNTHETIC_CREDENTIAL", "Lesson Bearer SYNTHETIC_CREDENTIAL",
      "Lesson access%255Ftoken%253DSYNTHETIC_CREDENTIAL",
      'Lesson {"access_token":"SYNTHETIC_CREDENTIAL"}',
      "Lesson https://SYNTHETIC_USER:SYNTHETIC_PASS@ordinary.test/lesson",
    ]) withheld("https://ordinary.test/lesson", title, "credential_context");
  });

  it("withholds credential assignments in paths and hash routes", () => {
    for (const url of [
      "https://ordinary.test/access_token=SYNTHETIC_CREDENTIAL/lesson",
      "https://ordinary.test/lesson/token%253DSYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson#/unit?access_token=SYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson#!access_token=SYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson#%252Funit%253Faccess_token%253DSYNTHETIC_CREDENTIAL",
    ]) withheld(url, "Lesson", "credential_context");
  });

  it("withholds generic authentication assignments while preserving prose about them", () => {
    for (const key of ["token", "auth", "secret", "signature", "sig"]) {
      withheld(`https://ordinary.test/lesson?${key}=SYNTHETIC_CREDENTIAL`, "Lesson", "credential_context");
      withheld("https://ordinary.test/lesson", `Lesson ${key}=SYNTHETIC_CREDENTIAL`, "credential_context");
    }
    assert.equal(ready("https://ordinary.test/lesson?topic=passwords", "Introduction to passwords and tokens").title,
      "Introduction to passwords and tokens");
  });

  it("withholds credential-bearing nested URLs and assignments in ordinary parameters", () => {
    for (const url of [
      "https://ordinary.test/lesson?next=https%3A%2F%2Fnested.test%2Flesson%3Faccess_token%3DSYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson?next=https%253A%252F%252FSYNTHETIC_USER%253ASYNTHETIC_PASS%2540nested.test%252Flesson",
      "https://ordinary.test/lesson?q=note%26password%3DSYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson?access_token=https%3A%2F%2Fnested.test%2Flesson%3Ftoken%3DSYNTHETIC_CREDENTIAL",
      "https://ordinary.test/lesson?resource=Authorization%3A+Bearer+SYNTHETIC_CREDENTIAL",
    ]) withheld(url, "Lesson", "credential_context");
  });

  it("permits ordinary nested resources that contain no recognized credential context", () => {
    const url = "https://ordinary.test/lesson?resource=https%3A%2F%2Fresource.test%2Funit%3Fid%3D2";
    assert.equal(ready(url, "Lesson").url, url);
  });

  it("withholds contextual OAuth codes inside nested resources, hash routes and titles", () => {
    for (const inner of [
      "https://auth.test/oauth/callback?code=SYNTHETIC_CODE&state=unit",
      "https://auth.test/work?code=SYNTHETIC_CODE&client_id=application",
    ]) withheld(`https://ordinary.test/lesson?next=${encodeURIComponent(inner)}`, "Lesson", "authentication_context");
    withheld("https://ordinary.test/lesson#/callback?code=SYNTHETIC_CODE", "Lesson", "credential_context");
    withheld("https://ordinary.test/lesson#/work?code=SYNTHETIC_CODE&client_id=application", "Lesson", "credential_context");
    withheld("https://ordinary.test/lesson", "https://auth.test/callback?code=SYNTHETIC_CODE", "credential_context");
    const ordinary = "https://ordinary.test/lesson?next=https%3A%2F%2Fresource.test%2Flesson%3Fcode%3Dlesson-2";
    assert.equal(ready(ordinary, "Lesson").url, ordinary);
  });

  it("withholds AWS/Google signed-link and SAML fields", () => {
    for (const key of ["X-Amz-Signature", "X-Amz-Date", "X_Goog_Credential", "x-goog-expires", "AWSAccessKeyId", "GoogleAccessId", "SAMLRequest", "SAMLResponse", "SAMLart"]) {
      withheld(`https://ordinary.test/lesson?${key}=SYNTHETIC_CREDENTIAL`, "Lesson", "credential_context");
    }
  });

  it("withholds OAuth codes only when accompanied by authentication context", () => {
    for (const context of ["client_id=application", "redirect_uri=callback", "response_type=code", "scope=read", "grant_type=authorization_code", "code_challenge=CHALLENGE", "code_verifier=VERIFIER", "nonce=NONCE"]) {
      withheld(`https://ordinary.test/lesson?code=SYNTHETIC_CREDENTIAL&${context}`, "Lesson", "authentication_context");
    }
    withheld("https://ordinary.test/callback?code=SYNTHETIC_CREDENTIAL&state=unit", "Lesson", "authentication_context");
    const ordinary = "https://ordinary.test/lesson?code=algebra&key=math&id=2&state=unit";
    assert.equal(ready(ordinary, "Lesson").url, ordinary);
  });

  it("combines contextual OAuth code recognition across URL and title fields", () => {
    withheld("https://ordinary.test/oauth/callback", "code=SYNTHETIC_OAUTH_CODE", "authentication_context");
    withheld("https://ordinary.test/work?client_id=synthetic-client", "code=SYNTHETIC_OAUTH_CODE", "authentication_context");
    withheld("https://ordinary.test/work?code=SYNTHETIC_OAUTH_CODE", "client_id=synthetic-client", "authentication_context");
    withheld("https://ordinary.test/work?description=client%255Fid%253Dsynthetic-client", "code=SYNTHETIC_OAUTH_CODE", "authentication_context");
    withheld("https://ordinary.test/lesson#description=code%3DSYNTHETIC_OAUTH_CODE", "client_id=synthetic-client", "authentication_context");
    assert.equal(ready("https://ordinary.test/lesson?code=lesson-2", "Classroom exercise").url,
      "https://ordinary.test/lesson?code=lesson-2");
    assert.equal(ready("https://ordinary.test/lesson", "Exercise code=lesson-2").title,
      "Exercise code=lesson-2");
    const ordinaryNested = "https://ordinary.test/lesson?next=https%3A%2F%2Fresource.test%2Flesson%3Fcode%3Dlesson-2";
    assert.equal(ready(ordinaryNested, "Classroom exercise").url, ordinaryNested);
  });

  it("withholds authentication routes when credentials exist, even with a descriptive title", () => {
    for (const path of ["/login", "/Login", "/oauth2/callback", "/sso/start", "/saml", "/auth", "/sign-in", "/callback.html", "/%256Cogin"]) {
      withheld(`https://ordinary.test${path}?access_token=SYNTHETIC_CREDENTIAL`, "Classroom assignment", "authentication_context");
    }
    assert.equal(ready("https://ordinary.test/login", "Educational explanation of login").url,
      "https://ordinary.test/login");
  });

  it("requires a retained substantive path, parameter, fragment or title after redaction", () => {
    withheld("https://ordinary.test/?access_token=SYNTHETIC_CREDENTIAL", undefined, "insufficient_context");
    withheld("https://ordinary.test/#access_token=SYNTHETIC_CREDENTIAL", "New tab", "insufficient_context");
    for (const [url, title] of [
      ["https://ordinary.test/lesson?access_token=SYNTHETIC_CREDENTIAL", "Unknown"],
      ["https://ordinary.test/?q=fractions&access_token=SYNTHETIC_CREDENTIAL", "Unknown"],
      ["https://ordinary.test/?access_token=SYNTHETIC_CREDENTIAL#chapter", "Unknown"],
      ["https://ordinary.test/?access_token=SYNTHETIC_CREDENTIAL", "Fractions assignment"],
    ]) ready(url!, title);
  });

  it("withholds residual credential values in every supported representation", () => {
    withheld("https://ordinary.test/lesson?access_token=SYNTHETIC_CREDENTIAL", "Lesson SYNTHETIC_CREDENTIAL", "residual_credential");
    withheld("https://ordinary.test/lesson?access_token=SYNTHETIC_CREDENTIAL&resource=SYNTHETIC%255FCREDENTIAL", "Lesson", "residual_credential");
    withheld("https://SYNTHETIC_USER:SYNTHETIC_PASS@ordinary.test/lesson", "Lesson SYNTHETIC_USER", "residual_credential");
    withheld("https://ordinary.test/lesson?password=SYNTHETIC+PASSWORD&resource=SYNTHETIC%20PASSWORD", "Lesson", "residual_credential");
    withheld("https://ordinary.test/lesson?access_token=a", "Lesson", "residual_credential");
  });

  it("tracks a recognized Bearer token separately and withholds ambiguous compound credentials", () => {
    assert.equal(ready("https://ordinary.test/lesson?authorization=Bearer%20SYNTHETIC_CREDENTIAL", "Lesson").url,
      `https://ordinary.test/lesson?authorization=${MARKER}`);
    withheld("https://ordinary.test/lesson?authorization=Bearer%20SYNTHETIC_CREDENTIAL&resource=SYNTHETIC_CREDENTIAL", "Lesson", "residual_credential");
    withheld("https://ordinary.test/lesson?authorization=Bearer%20SYNTHETIC_CREDENTIAL", "Lesson SYNTHETIC_CREDENTIAL", "residual_credential");
    for (const value of [
      "Basic%20SYNTHETIC_CREDENTIAL", "%22SYNTHETIC_CREDENTIAL%22", "SYNTHETIC_CREDENTIAL;resource=lesson",
      "SYNTHETIC_CREDENTIAL%26resource%3Dlesson", "password%3DSYNTHETIC_CREDENTIAL", "Bearer%20!SYNTHETIC_CREDENTIAL",
    ]) withheld(`https://ordinary.test/lesson?authorization=${value}`, "Lesson", "credential_context");
  });

  it("does not trust an input redaction marker or incomplete credential-field spans", () => {
    for (const url of [
      `https://ordinary.test/lesson?access_token=${MARKER}`,
      "https://ordinary.test/lesson?note=%5BREDACTED_CREDENTIAL%5D",
      "https://ordinary.test/lesson?access_token",
      "https://ordinary.test/lesson?access_token%3DSYNTHETIC_CREDENTIAL=lesson",
      'https://ordinary.test/lesson?"access_token"=SYNTHETIC_CREDENTIAL',
      "https://ordinary.test/lesson#%22access_token%22=SYNTHETIC_CREDENTIAL",
    ]) withheld(url, "Lesson", "credential_context");
    withheld("https://ordinary.test/lesson", `Lesson ${MARKER}`, "credential_context");
  });

  it("limits decoding to two passes and withholds malformed encodings", () => {
    for (const url of [
      "https://ordinary.test/lesson?access_token=SYNTHETIC%ZZCREDENTIAL",
      "https://ordinary.test/lesson?access_token=%FF",
      "https://ordinary.test/lesson%",
    ]) withheld(url, "Lesson", "malformed_encoding");
    withheld("https://ordinary.test/lesson?access%25255Ftoken=SYNTHETIC_CREDENTIAL", "Lesson", "ambiguous_encoding");
    withheld("https://ordinary.test/lesson", "access%25255Ftoken%25253DSYNTHETIC_CREDENTIAL", "ambiguous_encoding");
  });

  it("withholds invalid URL structures and raw or encoded control/backslash characters", () => {
    for (const url of [
      "ordinary.test/lesson", "//ordinary.test/lesson", "ftp://ordinary.test/lesson", "https:/ordinary.test/lesson",
      " https://ordinary.test/lesson", "https://ordinary.test/lesson ", "https://ordinary.test/les son",
      "https://user@other@ordinary.test/lesson", "https://ordinary.test/lesson\\next", "https://ordinary.test/lesson%5Cnext",
      "https://ordinary.test/lesson\nnext", "https://ordinary.test/lesson%0Anext", "https://ordinary.test/lesson%2500next",
    ]) withheld(url, "Lesson");
    withheld("https://ordinary.test/lesson", "Lesson\npassword=SYNTHETIC_CREDENTIAL", "invalid_input");
    withheld("https://ordinary.test/lesson", "Lesson%250Apassword=SYNTHETIC_CREDENTIAL", "invalid_input");
  });

  it("accepts the exact length bounds and withholds oversized inputs without truncation", () => {
    const prefix = "https://ordinary.test/";
    const maxUrl = prefix + "x".repeat(4_096 - prefix.length);
    assert.equal(ready(maxUrl, "A".repeat(512)).url, maxUrl);
    withheld(`${maxUrl}x`, "Lesson", "input_too_long");
    withheld("https://ordinary.test/lesson", "A".repeat(513), "input_too_long");
  });

  it("returns bounded unavailable shapes for unexpected runtime input types without throwing", () => {
    assert.deepEqual(Reflect.apply(prepareClasspilotAiRequestInput, undefined, [undefined]),
      { kind: "unavailable", reasonCode: "invalid_input" });
    assert.deepEqual(Reflect.apply(prepareClasspilotAiRequestInput, undefined,
      ["https://ordinary.test/lesson", { title: "synthetic" }]),
    { kind: "unavailable", reasonCode: "invalid_input" });
  });
});

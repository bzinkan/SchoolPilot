/** Browser-classification provider projection; never use it for resource matching. */
export const CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION = "classpilot-ai-request-input-2026-10-08.1";

const REDACTION_MARKER = "[REDACTED_CREDENTIAL]";
const MAX_URL_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 512;

export type PreparedClasspilotAiRequestInput = {
  kind: "ready";
  url: string;
  title: string;
  policyVersion: typeof CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION;
};

export type ClasspilotAiRequestInputUnavailableReason =
  | "invalid_input"
  | "invalid_url"
  | "input_too_long"
  | "malformed_encoding"
  | "ambiguous_encoding"
  | "credential_context"
  | "authentication_context"
  | "insufficient_context"
  | "residual_credential";

export type ClasspilotAiRequestInput = PreparedClasspilotAiRequestInput | {
  kind: "unavailable";
  reasonCode: ClasspilotAiRequestInputUnavailableReason;
};

const REDACTABLE_KEYS = new Set([
  "access_token", "id_token", "refresh_token", "oauth_token", "api_key", "apikey",
  "client_secret", "password", "passwd", "pwd", "authorization",
]);
const AMBIGUOUS_KEYS = new Set(["token", "auth", "secret", "signature", "sig"]);
const SAML_KEYS = new Set(["samlrequest", "samlresponse", "samlart"]);
const OAUTH_CONTEXT_KEYS = new Set([
  "client_id", "redirect_uri", "response_type", "scope", "grant_type",
  "code_challenge", "code_challenge_method", "code_verifier", "nonce",
]);
const PLACEHOLDER_TITLES = new Set([
  "", "unknown", "untitled", "new tab", "signing in", "login", "log in", "sign in",
]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const MALFORMED_PERCENT = /%(?![\da-f]{2})/i;
const ENCODED_BYTE = /%[\da-f]{2}/i;
const AUTH_ROUTE = /(?:^|\/)(?:auth|authenticate|authentication|authorize|authorization|login|log-in|signin|sign-in|oauth2?|sso|saml|callback)(?:[\/?#;.\-_]|$)/i;
const CREDENTIAL_ASSIGNMENT = /(?:^|[^\p{L}\p{N}_-])["']?(?:access[-_]token|id[-_]token|refresh[-_]token|oauth[-_]token|api[-_]?key|client[-_]secret|password|passwd|pwd|authorization|token|auth|secret|signature|sig|samlrequest|samlresponse|samlart|awsaccesskeyid|googleaccessid|x[-_]amz[-_][\w-]+|x[-_]goog[-_][\w-]+)["']?\s*[:=]/iu;
const BEARER = /(?:^|[^\p{L}\p{N}_])bearer\s+[^\s&#;,]+/iu;
const NESTED_USERINFO = /https?:\/\/[^\s/?#]*@/i;
const CODE_ASSIGNMENT = /(?:^|[^\p{L}\p{N}_-])["']?code["']?\s*[:=]/iu;
const OAUTH_CONTEXT_ASSIGNMENT = /(?:^|[^\p{L}\p{N}_-])["']?(?:client[-_]id|redirect[-_]uri|response[-_]type|scope|grant[-_]type|code[-_]challenge(?:[-_]method)?|code[-_]verifier|nonce)["']?\s*[:=]/iu;
const BEARER_VALUE = /^bearer\s+([a-z\d._~+/-]+=*)$/i;

class InputUnavailable extends Error {
  constructor(readonly reasonCode: ClasspilotAiRequestInputUnavailableReason) {
    super(reasonCode);
  }
}

function unavailable(reason: ClasspilotAiRequestInputUnavailableReason): never {
  throw new InputUnavailable(reason);
}

/** Inspection copies only. Never reserialize an observed URL from decoded data. */
function inspectionForms(raw: string, formStyle: boolean, strictPercent: boolean): string[] {
  if (CONTROL.test(raw) || raw.includes("\\")) unavailable("invalid_input");
  if (strictPercent && MALFORMED_PERCENT.test(raw)) unavailable("malformed_encoding");
  const forms = [raw];
  let current = formStyle ? raw.replace(/\+/g, " ") : raw;
  if (current !== raw) forms.push(current);
  for (let pass = 0; pass < 2 && ENCODED_BYTE.test(current); pass += 1) {
    try {
      // Literal percent signs in titles or produced by %25 do not themselves
      // demand another decoding pass. Valid encoded bytes still do.
      current = decodeURIComponent(current.replace(/%(?![\da-f]{2})/gi, "%25"));
    } catch {
      unavailable("malformed_encoding");
    }
    if (CONTROL.test(current) || current.includes("\\")) unavailable("invalid_input");
    forms.push(current);
  }
  if (ENCODED_BYTE.test(current)) unavailable("ambiguous_encoding");
  if (forms.some((form) => form.includes(REDACTION_MARKER))) unavailable("credential_context");
  return [...new Set(forms)];
}

function normalizedKey(forms: string[]): string {
  return forms[forms.length - 1]!.toLowerCase().replace(/-/g, "_");
}

function forbiddenKey(key: string): boolean {
  return AMBIGUOUS_KEYS.has(key) || SAML_KEYS.has(key)
    || key.startsWith("x_amz_") || key.startsWith("x_goog_")
    || key === "awsaccesskeyid" || key === "googleaccessid";
}

function containsCredentialContext(text: string): boolean {
  return CREDENTIAL_ASSIGNMENT.test(text) || BEARER.test(text) || NESTED_USERINFO.test(text)
    || (CODE_ASSIGNMENT.test(text) && (AUTH_ROUTE.test(text) || OAUTH_CONTEXT_ASSIGNMENT.test(text)));
}

function recordCredentialValue(forms: string[], values: Set<string>): void {
  const decoded = forms[forms.length - 1]!;
  // A compound/quoted field has no reviewed inner credential span. Removing
  // its outer value alone could miss the credential repeated elsewhere.
  if (/["'`{}\[\];&]/.test(decoded) || CREDENTIAL_ASSIGNMENT.test(decoded)
    || /^(?:basic|digest|negotiate|ntlm)\s/i.test(decoded.trim())) {
    unavailable("credential_context");
  }
  if (/^bearer(?:\s|$)/i.test(decoded.trim()) && !BEARER_VALUE.test(decoded.trim())) {
    unavailable("credential_context");
  }
  for (const form of forms) {
    if (form) values.add(form);
    const bearer = BEARER_VALUE.exec(form.trim());
    if (bearer?.[1]) values.add(bearer[1]);
  }
}

function credentialBearingNestedUrl(forms: string[]): boolean {
  return forms.some((form) => /https?:\/\//i.test(form) && containsCredentialContext(form));
}

type Parameter = {
  key: string;
  valueForms: string[];
  valueStart: number;
  valueEnd: number;
  hasEquals: boolean;
};

function parameters(raw: string, absoluteStart: number): Parameter[] {
  let cursor = absoluteStart;
  return raw.split("&").map((segment) => {
    const equals = segment.indexOf("=");
    const rawKey = equals < 0 ? segment : segment.slice(0, equals);
    const keyForms = inspectionForms(rawKey, true, true);
    const key = normalizedKey(keyForms);
    if (keyForms.some((form) => /[&=\s/?#!]/.test(form) || containsCredentialContext(form)
      || (!REDACTABLE_KEYS.has(key) && containsCredentialContext(`${form}=`)))) {
      unavailable("credential_context");
    }
    const rawValue = equals < 0 ? "" : segment.slice(equals + 1);
    const result = {
      key,
      valueForms: inspectionForms(rawValue, true, true),
      valueStart: cursor + (equals < 0 ? segment.length : equals + 1),
      valueEnd: cursor + segment.length,
      hasEquals: equals >= 0,
    };
    cursor += segment.length + 1;
    return result;
  });
}

type Replacement = { start: number; end: number; text: string };

/**
 * This finite policy removes reviewed, separable credential fields and withholds
 * ambiguous observations. It is not an assertion that arbitrary text is secret-free.
 */
export function prepareClasspilotAiRequestInput(url: string, title?: string): ClasspilotAiRequestInput {
  try {
    if (typeof url !== "string" || (title !== undefined && typeof title !== "string")) {
      unavailable("invalid_input");
    }
    const preparedTitle = title || "Unknown";
    if (url.length > MAX_URL_LENGTH || (title?.length ?? 0) > MAX_TITLE_LENGTH) {
      unavailable("input_too_long");
    }
    if (CONTROL.test(url) || /\s|\\/.test(url)) unavailable("invalid_url");
    const parts = /^(https?:\/\/)([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(url);
    if (!parts) unavailable("invalid_url");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      unavailable("invalid_url");
    }
    if (!parsed.hostname || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      unavailable("invalid_url");
    }

    const prefix = parts[1]!;
    const authority = parts[2]!;
    const rawPath = parts[3]!;
    const rawQuery = parts[4];
    const rawFragment = parts[5];
    const pathForms = inspectionForms(rawPath, false, true);
    const titleForms = inspectionForms(preparedTitle, false, false);
    if ([...pathForms, ...titleForms].some(containsCredentialContext)) unavailable("credential_context");

    const replacements: Replacement[] = [];
    const credentialValues = new Set<string>();
    let hasCredentials = false;
    const at = authority.indexOf("@");
    if (at >= 0) {
      if (at !== authority.lastIndexOf("@")) unavailable("invalid_url");
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(":");
      const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
      const password = colon < 0 ? "" : userinfo.slice(colon + 1);
      for (const value of [user, password]) {
        inspectionForms(value, false, true).forEach((form) => {
          if (form) credentialValues.add(form);
        });
      }
      replacements.push({ start: prefix.length, end: prefix.length + at + 1, text: "" });
      hasCredentials = true;
    }
    // A credential-shaped hostname or encoded authority delimiter is ambiguous.
    const destinationAuthority = authority.slice(at + 1);
    if (destinationAuthority.includes("%") || containsCredentialContext(destinationAuthority)) unavailable("invalid_url");

    const queryStart = prefix.length + authority.length + rawPath.length + 1;
    const queryParameters = rawQuery === undefined ? [] : parameters(rawQuery, queryStart);
    const fragmentStart = prefix.length + authority.length + rawPath.length
      + (rawQuery === undefined ? 0 : rawQuery.length + 1) + 1;
    let fragmentParameters: Parameter[] = [];
    let fragmentForms: string[] = [];
    if (rawFragment !== undefined) {
      fragmentForms = inspectionForms(rawFragment, false, true);
      const plainKeyValues = rawFragment.includes("=")
        && !/^[\/!?]/.test(rawFragment) && !/[?#]/.test(rawFragment);
      if (plainKeyValues) fragmentParameters = parameters(rawFragment, fragmentStart);
      else if (fragmentForms.some(containsCredentialContext)) unavailable("credential_context");
    }
    const allParameters = [...queryParameters, ...fragmentParameters];
    const authRoute = pathForms.some((form) => AUTH_ROUTE.test(form));
    // URL and title are one observation. A code in one field can be an OAuth
    // credential because of a route or explicit authentication field in another.
    // Reuse already bounded inspection copies; this adds no decoding passes.
    const contextForms = [
      ...pathForms, ...titleForms, ...fragmentForms,
      ...allParameters.flatMap((parameter) => parameter.valueForms),
    ];
    const hasCodeAssignment = contextForms.some((form) => CODE_ASSIGNMENT.test(form))
      || allParameters.some((parameter) => parameter.key === "code" && parameter.hasEquals);
    const hasOAuthContext = authRoute || hasCredentials
      || contextForms.some((form) => AUTH_ROUTE.test(form) || OAUTH_CONTEXT_ASSIGNMENT.test(form)
        || CREDENTIAL_ASSIGNMENT.test(form) || BEARER.test(form))
      || allParameters.some((parameter) => OAUTH_CONTEXT_KEYS.has(parameter.key)
        || REDACTABLE_KEYS.has(parameter.key) || forbiddenKey(parameter.key));
    if (hasCodeAssignment && hasOAuthContext) {
      unavailable("authentication_context");
    }

    for (const parameter of allParameters) {
      if (forbiddenKey(parameter.key)) unavailable("credential_context");
      if (credentialBearingNestedUrl(parameter.valueForms)) unavailable("credential_context");
      if (REDACTABLE_KEYS.has(parameter.key)) {
        // A named field without '=' cannot supply a reliable value replacement span.
        if (!parameter.hasEquals) unavailable("credential_context");
        recordCredentialValue(parameter.valueForms, credentialValues);
        replacements.push({ start: parameter.valueStart, end: parameter.valueEnd, text: REDACTION_MARKER });
        hasCredentials = true;
      } else if (parameter.valueForms.some(containsCredentialContext)) {
        unavailable("credential_context");
      }
    }
    if (hasCredentials && authRoute) unavailable("authentication_context");

    if (hasCredentials) {
      const meaningfulPath = pathForms.some((form) => form.replace(/[/.\s]/g, "").length > 0);
      const meaningfulParameter = allParameters.some((parameter) => parameter.key.length > 0
        && !REDACTABLE_KEYS.has(parameter.key)
        && (!parameter.hasEquals || parameter.valueForms.some((form) => form.length > 0)));
      const meaningfulFragment = fragmentParameters.length === 0
        && fragmentForms.some((form) => form.replace(/[\s/!]/g, "").length > 0);
      const meaningfulTitle = !PLACEHOLDER_TITLES.has(preparedTitle.trim().toLowerCase());
      if (!meaningfulPath && !meaningfulParameter && !meaningfulFragment && !meaningfulTitle) {
        unavailable("insufficient_context");
      }
    }

    let preparedUrl = url;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      preparedUrl = preparedUrl.slice(0, replacement.start) + replacement.text + preparedUrl.slice(replacement.end);
    }
    // Only markers inserted above are removed from this inspection copy. Input
    // markers were rejected by inspectionForms, so they cannot hide a residual.
    const residualUrl = preparedUrl.split(REDACTION_MARKER).join("");
    const residualForms = [
      ...inspectionForms(residualUrl, false, true),
      ...titleForms,
      ...allParameters.filter((parameter) => !REDACTABLE_KEYS.has(parameter.key)).flatMap((parameter) => parameter.valueForms),
    ];
    for (const value of credentialValues) {
      // Deliberately no exemption for short values; uncertain projections are unavailable.
      if (residualForms.some((form) => form.includes(value))) unavailable("residual_credential");
    }
    return {
      kind: "ready", url: preparedUrl, title: preparedTitle,
      policyVersion: CLASSPILOT_AI_REQUEST_INPUT_POLICY_VERSION,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      reasonCode: error instanceof InputUnavailable ? error.reasonCode : "invalid_input",
    };
  }
}

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

export type GoogleOAuthTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  expiry_date?: number;
};

export type GoogleUserInfo = {
  id?: string;
  email?: string;
  picture?: string;
};

export async function exchangeGoogleAuthCode({
  code,
  redirectUri,
  context,
}: {
  code: string;
  redirectUri: string;
  context: string;
}): Promise<GoogleOAuthTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth client credentials are not configured");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  let data: GoogleTokenResponse = {};
  if (text) {
    try {
      data = JSON.parse(text) as GoogleTokenResponse;
    } catch {
      throw new Error(
        `Google token exchange returned non-JSON response (${context}, status ${response.status})`
      );
    }
  }

  if (!response.ok) {
    const detail = data.error_description || data.error || response.statusText;
    throw new Error(`Google token exchange failed (${context}, status ${response.status}): ${detail}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token,
    expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

export async function fetchGoogleUserInfo(
  accessToken: string | undefined,
  context: string
): Promise<GoogleUserInfo> {
  if (!accessToken) {
    throw new Error(`Google userinfo request missing access token (${context})`);
  }

  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await response.text();
  let data: GoogleUserInfo & { error?: string; error_description?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as GoogleUserInfo & { error?: string; error_description?: string };
    } catch {
      throw new Error(
        `Google userinfo returned non-JSON response (${context}, status ${response.status})`
      );
    }
  }

  if (!response.ok) {
    const detail = data.error_description || data.error || response.statusText;
    throw new Error(`Google userinfo failed (${context}, status ${response.status}): ${detail}`);
  }

  return data;
}

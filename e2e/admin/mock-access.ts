// Test-only Access issuer. Production Workers never import this module.
const teamDomain = "https://playwright.cloudflareaccess.com";
const audience = "hifiscout-local-playwright";
const kid = "ephemeral-playwright-key";

export type MockAccessMode = "valid" | "expired" | "wrong-audience" | "invalid-signature";

export async function createMockAccess() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256" };
  const unexpectedRequests: string[] = [];
  const fetchJwks: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${teamDomain}/cdn-cgi/access/certs`) {
      unexpectedRequests.push(url);
      throw new Error(`Unexpected outbound request in admin test: ${url}`);
    }
    return Response.json({ keys: [jwk] });
  };

  async function headers(mode: MockAccessMode = "valid"): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode({
      iss: teamDomain,
      aud: mode === "wrong-audience" ? "another-application" : audience,
      exp: mode === "expired" ? now - 60 : now + 3600,
      nbf: now - 120,
      sub: "local-playwright-admin",
    })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(input),
    );
    const bytes = new Uint8Array(signature);
    if (mode === "invalid-signature") bytes[0] ^= 0xff;
    return {
      "cf-access-jwt-assertion": `${input}.${Buffer.from(bytes).toString("base64url")}`,
    };
  }

  return { teamDomain, audience, fetchJwks, headers, unexpectedRequests };
}

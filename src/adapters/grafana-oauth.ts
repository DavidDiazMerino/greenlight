import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredOAuthState {
  schemaVersion: "1.0";
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface GrafanaOAuthOptions {
  redirectUrl?: string;
  storePath?: string;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

/**
 * Local OAuth 2.1/PKCE provider for the hosted Grafana MCP service. Secrets are
 * persisted outside the repository in a user-only file and are never logged.
 */
export class PersistentGrafanaOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = undefined;
  private readonly redirect: URL;
  private readonly path: string;
  private readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
  private readonly oauthState = randomBytes(24).toString("hex");

  constructor(options: GrafanaOAuthOptions = {}) {
    this.redirect = new URL(options.redirectUrl ?? "http://127.0.0.1:9876/oauth/callback");
    if (this.redirect.protocol !== "http:" || this.redirect.hostname !== "127.0.0.1") {
      throw new Error("Grafana OAuth redirect must use http://127.0.0.1:<port>/oauth/callback");
    }
    this.path = options.storePath ?? join(homedir(), ".config", "greenlight", "grafana-oauth.json");
    this.onAuthorizationUrl = options.onAuthorizationUrl ?? openAuthorizationUrl;
  }

  get redirectUrl(): URL {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirect.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Greenlight Grafana MCP development client",
      client_uri: "https://github.com/DavidDiazMerino/greenlight",
      software_id: "dev.greenlight.grafana-mcp",
      software_version: "0.1.0",
    };
  }

  state(): string {
    return this.oauthState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.update({ tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.onAuthorizationUrl(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error("Grafana OAuth code verifier is missing; restart authorization");
    return verifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const stored = await this.load();
    if (scope === "all" || scope === "client") delete stored.clientInformation;
    if (scope === "all" || scope === "tokens") delete stored.tokens;
    if (scope === "all" || scope === "verifier") delete stored.codeVerifier;
    if (scope === "all" || scope === "discovery") delete stored.discoveryState;
    await this.save(stored);
  }

  async status(): Promise<{ hasClientRegistration: boolean; hasTokens: boolean; hasRefreshToken: boolean }> {
    const stored = await this.load();
    return {
      hasClientRegistration: Boolean(stored.clientInformation),
      hasTokens: Boolean(stored.tokens?.access_token),
      hasRefreshToken: Boolean(stored.tokens?.refresh_token),
    };
  }

  private async load(): Promise<StoredOAuthState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoredOAuthState;
      return { ...parsed, schemaVersion: "1.0" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "1.0" };
      throw error;
    }
  }

  private async update(patch: Partial<StoredOAuthState>): Promise<void> {
    await this.save({ ...await this.load(), ...patch, schemaVersion: "1.0" });
  }

  private async save(value: StoredOAuthState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export async function authorizeGrafanaMcp(options: {
  provider: PersistentGrafanaOAuthProvider;
  serverUrl: string;
  timeoutMs?: number;
}): Promise<"AUTHORIZED"> {
  const callback = await listenForOAuthCallback(options.provider.redirectUrl, options.provider.state(), options.timeoutMs ?? 300_000);
  try {
    const initial = await auth(options.provider, { serverUrl: options.serverUrl });
    if (initial === "AUTHORIZED") return initial;
    const authorizationCode = await callback.code;
    const completed = await auth(options.provider, { serverUrl: options.serverUrl, authorizationCode });
    if (completed !== "AUTHORIZED") throw new Error("Grafana OAuth did not complete after the callback");
    return completed;
  } finally {
    await callback.close();
  }
}

async function listenForOAuthCallback(redirectUrl: URL, expectedState: string, timeoutMs: number): Promise<{
  code: Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timer = setTimeout(() => rejectCode(new Error("Timed out waiting for the Grafana OAuth callback")), timeoutMs);
  timer.unref();
  const server = createServer((request, response) => {
    const incoming = new URL(request.url ?? "/", redirectUrl.origin);
    if (incoming.pathname !== redirectUrl.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = incoming.searchParams.get("error");
    const state = incoming.searchParams.get("state");
    const authorizationCode = incoming.searchParams.get("code");
    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Grafana authorization failed. You can close this tab.");
      rejectCode(new Error(`Grafana OAuth failed: ${error}`));
      return;
    }
    if (state !== expectedState || !authorizationCode) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback. You can close this tab.");
      rejectCode(new Error("Grafana OAuth callback had an invalid state or no code"));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Greenlight is connected to Grafana. You can close this tab.");
    resolveCode(authorizationCode);
  });
  server.listen(Number(redirectUrl.port), redirectUrl.hostname);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    code,
    close: async () => {
      clearTimeout(timer);
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function openAuthorizationUrl(url: URL): void {
  process.stdout.write(`Open this Grafana authorization URL if the browser does not start:\n${url.toString()}\n`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

import { dockerStatus } from "./scenarios";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { STUDIO_PROTOCOL_VERSION } from "../../../shared/protocol";
import { DEFAULT_FRONTEND_RELEASE } from "../../../shared/frontend-release";
import { batchPlan, discovery, discoveryFor, identity, NOW, overview, snapshot, stateful, workbench } from "./scenarios";
import { installEvents } from "./events";
import { connectionCatalogFixture, connectionObservationFixture } from "./aws-connections";
import { logEvidence, logPage } from "../../support/development-logs";
import { graphqlChainFixture } from "../../support/graphql-chain";
import { graphqlWorkspaceFixture } from "../../support/graphql-workspace";

const assets = path.resolve(__dirname, "../assets/fonts");
const legacyBaseline = process.env.STUDIO_BROWSER_BASELINE === "1";
export type Handler = (route: Route, url: URL) => Promise<void>;
export interface StudioFixture {
  readonly response: ReturnType<typeof snapshot>;
  readonly requests: { method: string; path: string; body: unknown }[];
  readonly sockets: string[];
  reply(method: string, pathname: string, handler: Handler): void;
  goto(pathname?: string): Promise<void>;
  settle(): Promise<void>;
  emit(type: string, data: unknown): Promise<void>;
}

export const test = base.extend<{ studio: StudioFixture; fixedClock: boolean }>({
  fixedClock: [true, { option: true }],
  studio: [async ({ context, page, fixedClock, baseURL }, use, testInfo) => {
    const response = snapshot(), requests: StudioFixture["requests"] = [], sockets: string[] = [], unexpected: string[] = [];
    const overrides = new Map<string, Handler>();
    const failures: string[] = [], consoleErrors: { text: string; url: string }[] = [];
    const expectedHTTPFailures: { status: number; url: string }[] = [];
    page.on("pageerror", error => failures.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location().url }); });
    page.on("response", result => {
      const url = new URL(result.url());
      if (result.status() >= 400 && overrides.has(`${result.request().method()} ${url.pathname}`)) expectedHTTPFailures.push({ status: result.status(), url: result.url() });
    });
    if (fixedClock) await page.clock.setFixedTime(new Date(NOW));
    await context.addInitScript(installEvents);
    // Operational scenarios represent a developer who explicitly configured a
    // connection. Onboarding specs opt out; the application has no fallback.
    await context.addInitScript(() => {
      const key = "aws-studio:mode-profiles:v1:/studio-fixture";
      try { if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ dev: "browser", prod: "browser" })); } catch { /* Storage failure scenarios own their session-only selections. */ }
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.hostname !== "studio-fixture.invalid") { unexpected.push(`WebSocket ${url}`); socket.close(); return; }
      socket.onMessage(message => { sockets.push(String(message)); socket.send(JSON.stringify({ received: JSON.parse(String(message)) })); });
    });
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === "fonts.googleapis.com") {
        if (url.pathname !== "/css2") { unexpected.push(`Font stylesheet ${url}`); await route.abort(); return; }
        const currentFonts = await readFile(path.join(assets, "fonts.css"), "utf8");
        const legacyFonts = legacyBaseline ? await readFile(path.join(assets, "legacy-barlow.css"), "utf8") : "";
        await route.fulfill({ contentType: "text/css", body: `${currentFonts}\n${legacyFonts}` }); return;
      }
      if (url.hostname === "fonts.gstatic.com") {
        const name = path.basename(url.pathname);
        // The application serves Barlow itself; only the frozen original build asks Google for it.
        const currentFont = /^(barlow-semi-condensed-(500|600)|jetbrains-mono-(400|500))\.woff2$/.test(name);
        const legacyFont = legacyBaseline && /^barlow-(400|500|600)\.woff2$/.test(name);
        if (!currentFont && !legacyFont) { unexpected.push(`Font ${url}`); await route.abort(); return; }
        await route.fulfill({ contentType: "font/woff2", path: path.join(assets, name), headers: { "access-control-allow-origin": "*" } }); return;
      }
      const fixturePort = new URL(baseURL ?? "http://127.0.0.1:4592").port;
      if (url.hostname !== "127.0.0.1" || ![fixturePort, String(Number(fixturePort) + 1)].includes(url.port)) { unexpected.push(`${request.method()} ${url}`); await route.abort(); return; }
      if (url.pathname.startsWith("/api/")) {
        const headers = request.headers();
        if (headers["x-studio-token"] !== "browser-fixture-token" || headers["x-studio-protocol"] !== STUDIO_PROTOCOL_VERSION) unexpected.push(`Missing fixture token/protocol: ${url.pathname}`);
        const body: unknown = request.postData() ? request.postDataJSON() : undefined;
        requests.push({ method: request.method(), path: `${url.pathname}${url.search}`, body });
        const override = overrides.get(`${request.method()} ${url.pathname}`);
        if (override) { await override(route, url); return; }
        let value: unknown;
        switch (`${request.method()} ${url.pathname}`) {
          case "GET /api/snapshot": value = response; break;
          case "GET /api/source-recovery": value = []; break;
          case "GET /api/machine/docker": value = dockerStatus(); break;
          case "GET /api/deploy/overview": value = overview(); break;
          case "GET /api/deploy/local": value = overview().local; break;
          case "GET /api/operations": value = { jobs: [] }; break;
          case "GET /api/development-logs/runs": value = { schemaVersion: 1, runs: [] }; break;
          case "GET /api/development-logs/entries": value = { ...logPage(), run: undefined, collection: "not-configured" }; break;
          case "GET /api/development-logs/evidence": value = { ...logEvidence(), run: undefined, collection: "not-configured" }; break;
          case "GET /api/development-logs/trace": value = {schemaVersion:1,source:"development",traceId:url.searchParams.get("traceId"),observedAt:NOW,collection:"not-configured",spans:[],roots:[],events:[],complete:false,gaps:[],dropped:0,truncated:0,omitted:0}; break;
          case "GET /api/deploy/profiles": value = overview().profiles; break;
          case "GET /api/aws-connections": value = connectionCatalogFixture(overview().profiles); break;
          case "POST /api/aws-connections/check": value = connectionObservationFixture((body as {profile:string}).profile); break;
          case "GET /api/deploy/identity": value = { ok: true, value: { context: { ...discovery().context, profile: url.searchParams.get("profile") } } }; break;
          case "GET /api/deploy/discover": value = { ok: true, value: discoveryFor(url) }; break;
          case "GET /api/deploy/status": value = { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), detail: undefined } }; break;
          case "GET /api/deploy/plans": value = []; break;
          case "GET /api/deploy/drift": value = null; break;
          case "GET /api/frontend-release/settings": value = { settings: DEFAULT_FRONTEND_RELEASE, hash: "browser-settings" }; break;
          case "GET /api/frontend-release/history": value = []; break;
          case "GET /api/frontend-release/identities": value = { hash: "browser-targets", authority: "Fixture source", targets: overview().targets }; break;
          case "GET /api/identity/source": value = identity(url.searchParams.get("mode") === "prod" ? "prod" : "dev"); break;
          case "GET /api/identity-policy/sources": value = { revision: "browser-revision", sources: [] }; break;
          case "GET /api/identity/operations": value = []; break;
          case "GET /api/stateful-resources/source": value = stateful(url.searchParams.get("mode") === "prod" ? "prod" : "dev"); break;
          case "GET /api/identity/domain-dns/history": value = []; break;
          case "GET /api/database/workbench": value = workbench(); break;
          case "GET /api/graphql/chain": value = graphqlChainFixture(); break;
          case "GET /api/graphql/workspace": value = graphqlWorkspaceFixture(); break;
          case "GET /api/graphql/runtime": value = { status: "stopped", endpoint: null, message: "Local API is stopped." }; break;
          case "GET /api/agent-tasks": value = { tasks: [] }; break;
          case "POST /api/database/workbench/validate": value = workbench().validation; break;
          case "POST /api/database/workbench/format": value = { source: (body as { source: string }).source }; break;
          case "GET /api/websockets/defaults": value = { local: "ws://studio-fixture.invalid/local?token=", apiGateway: "wss://studio-fixture.invalid/gateway?token=" }; break;
          case "POST /api/deploy/preferences": value = { profiles: {}, ...(body as object) }; break;
          case "POST /api/edits/batch/plan": value = batchPlan(); break;
          default: unexpected.push(`${request.method()} ${url.pathname}`); await route.fulfill({ status: 501, json: { error: `Unscripted browser fixture: ${request.method()} ${url.pathname}` } }); return;
        }
        await route.fulfill({ json: value }); return;
      }
      if (request.isNavigationRequest()) {
        const original = await route.fetch();
        let html = await original.text();
        html = html.replace(/<link[^>]*rel="preconnect"[^>]*>/g, "").replace("</head>", `<meta name="studio-token" content="browser-fixture-token"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head>`);
        await route.fulfill({ response: original, body: html }); return;
      }
      await route.continue();
    });
    const settle = async () => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const landscape = (window as unknown as { __studioLandscape?: { camera(): unknown; viewport(): unknown } }).__studioLandscape;
        if (!landscape) return;
        // The map debounces aspect/layout changes for 180ms. Two unchanged paint
        // frames can precede that update, so require camera/viewport stability
        // across the debounce too. This reads the existing diagnostic surface.
        await new Promise<void>((resolve, reject) => {
          const started = performance.now();
          let previous = "", stableSince = started;
          const sample = () => {
            const now = performance.now();
            const state = JSON.stringify([landscape.camera(), landscape.viewport()]);
            if (state !== previous) { previous = state; stableSince = now; }
            if (now - stableSince >= 250) { resolve(); return; }
            if (now - started >= 4000) { reject(new Error("Map camera/viewport did not settle")); return; }
            requestAnimationFrame(sample);
          };
          sample();
        });
      });
    };
    await use({ response, requests, sockets, reply: (method, pathname, handler) => overrides.set(`${method} ${pathname}`, handler),
      goto: async (pathname = "/") => { await page.goto(pathname); await expect(page.getByRole("navigation", { name: "Views", exact: true })).toBeVisible(); await settle(); }, settle,
      emit: async (type, data) => { await page.evaluate(({ type, data }) => (window as unknown as { __studioBrowserEvents: { emit(type: string, data: unknown): void } }).__studioBrowserEvents.emit(type, data), { type, data }); },
    });
    // Browser-generated HTTP errors are expected only for a matching explicit
    // error-state fixture. Application console errors remain failures.
    const unexpectedConsoleErrors = consoleErrors.filter(error => {
      const status = /^Failed to load resource: the server responded with a status of (\d{3}) \(.+\)$/.exec(error.text)?.[1];
      return !status || !expectedHTTPFailures.some(result => result.url === error.url && result.status === Number(status));
    });
    await testInfo.attach("fixture-requests", { body: JSON.stringify({ requests, sockets, unexpected, pageErrors: failures, consoleErrors, expectedHTTPFailures }, null, 2), contentType: "application/json" });
    expect(unexpected, "All APIs and external transports must be explicitly fixture-backed").toEqual([]);
    expect(failures, "No uncaught application errors").toEqual([]);
    expect(unexpectedConsoleErrors, "No application console errors outside explicit HTTP error fixtures").toEqual([]);
  }, { auto: true }],
});
export { expect };
export async function assertAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const violations = results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }));
  expect(violations, "No accessibility violations").toEqual([]);
}

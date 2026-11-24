import { Cloud, Laptop, type LucideIcon } from "lucide-react";
import { usePublishSightline } from "../../sightline/bridge";
import { useQuery } from "@tanstack/react-query";
import type { Mode } from "../../../shared/model";
import { api } from "../../api";
import { useStudio } from "../../studio";
import { LAUNCH_URL_PARAMS, connectionUrlWithToken, consumeLaunchToken, launchConnectionUrl } from "../../websockets/launch";
import { WebSocketTester } from "./WebSocketTester";
import { documentSupportClasses, pageBodyClasses } from "../DocumentUI";
import { noticeClasses } from "../../ui/Surface";
import { cx } from "../../ui/classes";

/**
 * One WebSocket panel for the selected Source mode: local-ws-dev-server in
 * Development, the deployed API Gateway stage in Production. Only a production
 * deployment builds the WebSocket API; development runs its handlers under Compose.
 *
 * The page accepts client-app's launch link. The token in its fragment is taken and
 * cleared from the address bar as soon as this page loads; the URLs it names are read
 * then too, before anything navigates. Opened directly, the panel starts from the
 * exported setting for its mode.
 */

const launchToken = consumeLaunchToken();
// Without a fallback these are the launch link's own URLs, or empty when it names none.
const launchLocal = launchConnectionUrl(LAUNCH_URL_PARAMS.local, undefined);
const launchApiGateway = launchConnectionUrl(LAUNCH_URL_PARAMS.apiGateway, undefined);

const PANELS = {
  dev: { icon: Laptop, title: "Local", description: "local-ws-dev-server under Compose" },
  prod: { icon: Cloud, title: "AWS", description: "The deployed API Gateway WebSocket stage" },
} as const satisfies Record<Mode, { icon: LucideIcon; title: string; description: string }>;

export function WebSockets() {
  const { mode } = useStudio();
  return <WebSocketsWorkspace mode={mode} />;
}

export function WebSocketsWorkspace({ mode }: { readonly mode: Mode }) {
  const defaults = useQuery({ queryKey: ["websocket-defaults"], queryFn: api.webSocketDefaults, staleTime: Number.POSITIVE_INFINITY, retry: false });
  usePublishSightline("websockets", () => ({ availability: defaults.isPending ? "loading" : defaults.error ? "error" : "available" }));
  const fallback = defaults.data ?? { local: "", apiGateway: "" };
  const url = mode === "dev" ? launchLocal || fallback.local.trim() : launchApiGateway || fallback.apiGateway.trim();
  const panel = PANELS[mode];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No title bar: the panel's own header opens the column, 16px below the navbar like every page. */}
      <div className={cx(pageBodyClasses, "flex min-h-0 flex-1 flex-col gap-4 vp-760:overflow-y-auto")}>
        {defaults.isPending ? (
          <p className={cx(documentSupportClasses, "flex min-h-8 items-center")} role="status">Reading the WebSocket settings…</p>
        ) : (
          <>
            {defaults.error ? <div className={noticeClasses({ className: "flex flex-wrap items-center gap-x-3 gap-y-2 [&>span]:min-w-0 [&>span]:flex-[1_1_280px]" })} role="alert"><span>The WebSocket defaults could not be read: {defaults.error.message}. Enter a URL to connect.</span></div> : null}
            {/* Keyed by mode: switching Source closes this mode's socket and starts the other's panel fresh. */}
            <WebSocketTester key={mode} icon={panel.icon} title={panel.title} description={panel.description} initialConnectionURL={connectionUrlWithToken(url, launchToken)} />
          </>
        )}
      </div>
    </div>
  );
}

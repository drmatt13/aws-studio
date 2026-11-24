/**
 * The connection URLs the WebSockets page starts from when a launch link names
 * none: `local` in Development, `apiGateway` in Production. Both are endpoint URLs,
 * never credentials; an empty string leaves the panel blank.
 */
export interface WebSocketDefaults {
  /** local-ws-dev-server on its published host port, with an empty `?token=` to fill. */
  readonly local: string;
  /** The production API Gateway WebSocket stage, once a production export has recorded one. */
  readonly apiGateway: string;
}

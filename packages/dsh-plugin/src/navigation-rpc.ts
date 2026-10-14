/** Plugin-owned calls on DSH's public authenticated Connection RPC carrier. */
export const NAVIGATION_CHANNEL = "/starlite-navigation";
export type RpcResult<T = unknown> =
  | {ok: true; value: T}
  | {ok: false; error: {code: string; message: string; details: object}};
export interface NavigationCommand {requestRef: string; sessionId: string; expiresAt: number}
export interface NavigationRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
}
export interface HostNavigationRpc {
  handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<RpcResult>): () => void | Promise<void>;
}
export function opaqueRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function sessionIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !Array.from(value).some(character => character.charCodeAt(0) < 32);
}
export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

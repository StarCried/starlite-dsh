import {describe, expect, it} from "vitest";
import {desktopNavigationContract} from "../dsh-desktop-contract.mjs";

const contract = {
  context: "extend(meta?: {}): this;",
  registry: "inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>;",
  fiber: "readonly dispose: () => Promise<void>;",
  profile: "interface ProfileContext { readonly name: string; } interface Context { profileContext: ProfileContext; }",
  host: "connection: HostConnectionHandle; get rpc(): HostConnectionRpc;",
  client: "readonly rpc: ClientConnectionRpc; 'connection/reset'(): void;",
  rpc: `type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<ConnectionRpcHandlerResult>;
    interface HostConnectionHandle { readonly rpc: HostConnectionRpc; }
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>;
    type ConnectionRpcResult<T> = { readonly ok: true; readonly value: T; } | { readonly ok: false; readonly error: ConnectionRpcFailure; };
    interface ConnectionRpcFailure { readonly code: string; readonly message: string; readonly details: object; }`,
};
describe("complete Desktop navigation contracts", () => {
  it("accepts the public launcher identity and authenticated cancellable RPC contract", () => {
    expect(desktopNavigationContract(contract)).toEqual({supported: true, missing: []});
  });
  it.each(["profile", "rpc", "host", "client", "registry", "fiber", "context"])("does not advertise Desktop when %s is absent on an older Web build", field => {
    expect(desktopNavigationContract({...contract, [field]: undefined}).supported).toBe(false);
  });
  it("requires dependency and disposer shapes rather than similarly named methods", () => {
    expect(desktopNavigationContract({...contract, registry: contract.registry.replace("Fiber & PromiseLike<Fiber>", "void")}).missing).toContain("service-owned dependency lifecycle");
    expect(desktopNavigationContract({...contract, fiber: "readonly dispose: () => void;"}).missing).toContain("async dependency disposal");
    expect(desktopNavigationContract({...contract, context: "extend(meta?: {}): void;"}).missing).toContain("non-mutating carrier context binding");
  });
  it.each([
    ["peer: PeerScope", "peer: string", "RPC request cancellation and peer identity"],
    ["signal: AbortSignal", "signal: unknown", "RPC request cancellation and peer identity"],
    ["handler: ConnectionRpcHandler): () => Promise<void>", "handler: ConnectionRpcHandler): void", "authenticated channel and async disposal"],
    ["payload: unknown, signal?: AbortSignal", "payload: string, signal?: AbortSignal", "client RPC cancellation and result"],
    ["readonly ok: true", "readonly ok: boolean", "RPC success result"],
  ])("rejects a similarly named changed shape %s", (before, after, missing) => {
    expect(desktopNavigationContract({...contract, rpc: contract.rpc.replace(before, after)}).missing).toContain(missing);
  });
});

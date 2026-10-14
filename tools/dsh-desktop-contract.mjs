/** Public contracts needed in addition to ordinary Web navigation. */
export function desktopNavigationContract(sources) {
  const requirements = [
    ["non-mutating carrier context binding", sources.context, /extend\(meta\?:\s*\{\}\):\s*this;/u],
    ["service-owned dependency lifecycle", sources.registry, /inject\(deps:\s*Inject,\s*callback:\s*Plugin\.Function<void>\):\s*Fiber\s*&\s*PromiseLike<Fiber>;/u],
    ["async dependency disposal", sources.fiber, /readonly\s+dispose:\s*\(\)\s*=>\s*Promise<void>;/u],
    ["launcher-owned profile name", sources.profile, /interface\s+ProfileContext\s*\{\s*readonly\s+name:\s*string;/u],
    ["public profile context service", sources.profile, /interface\s+Context\s*\{[^}]*profileContext:\s*ProfileContext;/u],
    ["Host Connection service", sources.host, /connection:\s*HostConnectionHandle;/u],
    ["context-owned RPC registration", sources.host, /get\s+rpc\(\):\s*HostConnectionRpc;/u],
    ["authenticated channel and async disposal", sources.rpc, /handle\(\s*channel:\s*string,\s*handler:\s*ConnectionRpcHandler\s*\):\s*\(\)\s*=>\s*Promise<void>;/u],
    ["RPC request cancellation and peer identity", sources.rpc, /type\s+ConnectionRpcHandler\s*=\s*\(\s*endpoint:\s*string,\s*payload:\s*unknown,\s*signal:\s*AbortSignal,\s*peer:\s*PeerScope\s*\)\s*=>\s*Promise<ConnectionRpcHandlerResult>;/u],
    ["Host RPC exposure", sources.rpc, /interface\s+HostConnectionHandle\s*\{[^}]*readonly\s+rpc:\s*HostConnectionRpc;/u],
    ["client RPC cancellation and result", sources.rpc, /call\(\s*channel:\s*string,\s*endpoint:\s*string,\s*payload:\s*unknown,\s*signal\?:\s*AbortSignal\s*\):\s*Promise<ConnectionRpcResult<unknown>>;/u],
    ["client Connection RPC service", sources.client, /readonly\s+rpc:\s*ClientConnectionRpc;/u],
    ["official client reconnect notification", sources.client, /'connection\/reset'\(\):\s*void;/u],
    ["RPC success result", sources.rpc, /type\s+ConnectionRpcResult<T>\s*=\s*\{\s*readonly\s+ok:\s*true;\s*readonly\s+value:\s*T;/u],
    ["RPC failure result", sources.rpc, /readonly\s+ok:\s*false;\s*readonly\s+error:\s*ConnectionRpcFailure;/u],
    ["plain RPC error fields", sources.rpc, /interface\s+ConnectionRpcFailure\s*\{\s*readonly\s+code:\s*string;\s*readonly\s+message:\s*string;\s*readonly\s+details:\s*object;/u],
  ];
  const missing = requirements.filter(([, text, pattern]) => !pattern.test(text ?? "")).map(([label]) => label);
  return {supported: missing.length === 0, missing};
}

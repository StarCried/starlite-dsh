import {randomUUID} from "node:crypto";
import {object, opaqueRef, type NavigationCommand, type RpcResult} from "./navigation-rpc.js";

export const DESKTOP_NAVIGATION_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 15_000;
const OWNER_GRACE_MS = 750;
interface Pending {
  sessionId: string;
  expiresAt: number;
  delivery?: {clientRef: string; requestRef: string};
  finish(opened: boolean): void;
}
interface Owner {
  clientRef: string;
  peer: unknown;
  poll?: {finish(value: NavigationCommand | null): void; cancel(): void};
  grace?: ReturnType<typeof setTimeout>;
}
function unavailable(): RpcResult {
  return {ok: false, error: {code: "starlite/navigation-unavailable", message: "DSH navigation unavailable", details: {}}};
}
function busy(): RpcResult {
  return {ok: false, error: {code: "starlite/navigation-busy", message: "DSH navigation renderer is still connected", details: {}}};
}

/** One Desktop renderer owns navigation; a reload may resume only an unexpired request. */
export class DesktopNavigationBroker {
  #pending: Pending | undefined;
  #owner: Owner | undefined;
  #closed = false;

  request(sessionId: string): {result: Promise<void>; cancel(): void} {
    this.#pending?.finish(false);
    let pending: Pending;
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => pending.finish(false), DESKTOP_NAVIGATION_TIMEOUT_MS);
      timer.unref?.();
      pending = {
        sessionId, expiresAt: Date.now() + DESKTOP_NAVIGATION_TIMEOUT_MS,
        finish: opened => {
          if (this.#pending !== pending) return;
          clearTimeout(timer);
          this.#pending = undefined;
          if (opened) resolve(); else reject(Error("DSH Desktop session unavailable"));
        },
      };
      this.#pending = pending;
    });
    // The opener may reject before the caller begins awaiting the result.
    void result.catch(() => undefined);
    if (this.#closed) pending!.finish(false);
    else this.#deliver();
    return {result, cancel: () => pending!.finish(false)};
  }

  async handle(endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown): Promise<RpcResult> {
    const row = object(payload);
    if (this.#closed || signal.aborted || !row || !opaqueRef(row.clientRef) || !peer) return unavailable();
    if (endpoint === "listen" && Object.keys(row).length === 1) return this.#listen(row.clientRef, peer, signal);
    const owner = this.#owner;
    if (!owner || owner.clientRef !== row.clientRef || owner.peer !== peer) return unavailable();
    if (endpoint === "release" && Object.keys(row).length === 1) {
      this.#release(owner);
      return {ok: true, value: null};
    }
    if (endpoint !== "ack" || Object.keys(row).length !== 3 || !opaqueRef(row.requestRef)
      || typeof row.opened !== "boolean") return unavailable();
    const pending = this.#pending;
    if (!pending || pending.expiresAt <= Date.now() || pending.delivery?.clientRef !== row.clientRef
      || pending.delivery.requestRef !== row.requestRef) return unavailable();
    pending.finish(row.opened);
    return {ok: true, value: null};
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending?.finish(false);
    if (this.#owner) this.#release(this.#owner);
  }

  #listen(clientRef: string, peer: unknown, signal: AbortSignal): Promise<RpcResult> {
    let owner = this.#owner;
    if (owner && (owner.clientRef !== clientRef || owner.peer !== peer || owner.poll)) return Promise.resolve(busy());
    if (!owner) {owner = {clientRef, peer}; this.#owner = owner;}
    clearTimeout(owner.grace);
    const currentOwner = owner;
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => finish(null), POLL_TIMEOUT_MS);
      timer.unref?.();
      const cancel = () => {
        if (settled) return;
        this.#release(currentOwner);
      };
      const finish = (value: NavigationCommand | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        delete currentOwner.poll;
        if (this.#owner === currentOwner) {
          currentOwner.grace = setTimeout(() => this.#release(currentOwner), OWNER_GRACE_MS);
          currentOwner.grace.unref?.();
        }
        resolve({ok: true, value});
      };
      currentOwner.poll = {finish, cancel};
      signal.addEventListener("abort", cancel, {once: true});
      this.#deliver();
    });
  }

  #deliver(): void {
    const pending = this.#pending, owner = this.#owner;
    if (!pending || !owner?.poll || pending.delivery || pending.expiresAt <= Date.now()) return;
    const requestRef = randomUUID();
    pending.delivery = {clientRef: owner.clientRef, requestRef};
    owner.poll.finish({requestRef, sessionId: pending.sessionId, expiresAt: pending.expiresAt});
  }

  #release(owner: Owner): void {
    if (this.#owner !== owner) return;
    this.#owner = undefined;
    clearTimeout(owner.grace);
    // A renderer that reloads must receive a new acknowledgement identity.
    if (this.#pending?.delivery?.clientRef === owner.clientRef) delete this.#pending.delivery;
    owner.poll?.finish(null);
  }
}

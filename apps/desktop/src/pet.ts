import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  PhysicalPosition,
  availableMonitors,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
  type Window,
} from "@tauri-apps/api/window";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import type { PetSnapshot, PetState, WidgetController } from "./vendor-types.js";
import type { DesktopSettings } from "./types.js";
import { StatusConnection } from "./connection.js";
import { createModelSlot, mountModel } from "./renderer.js";
import { StateAnimator } from "./state-animator.js";
import { InteractionMaskBridge } from "./interaction-mask.js";

const OFFLINE_EXIT_MS = 60_000;
const FIXED_BUBBLES: Partial<Record<PetState, string>> = {
  thinking: "正在工作…",
  working: "正在工作…",
  completed: "任务已完成",
  error: "发生错误，请查看 DSH",
  blocked: "任务被阻塞，请查看 DSH",
  approval: "等待批准，请查看 DSH",
};

export async function startPet(): Promise<void> {
  const window = getCurrentWindow();
  const host = requiredElement("model");
  const bubble = requiredElement<HTMLOutputElement>("bubble");
  const empty = requiredElement("empty-model");
  let settings = await invoke<DesktopSettings>("get_settings");
  const slot = await createModelSlot();
  let mountGeneration = 0;
  let controller: WidgetController | undefined;
  let animator: StateAnimator | undefined;
  let latestSnapshot: PetSnapshot | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedByTray = false;
  let connected = false;
  const interaction = new InteractionMaskBridge(
    mask => invoke("set_model_hit_mask", {mask}),
    () => { void window.hide(); void invoke("open_settings"); },
  );
  await listen<{x: number; y: number}>("pet-cursor", ({payload}) => {
    controller?.setPointerPosition(payload.x, payload.y);
  });
  const stopMovement = await window.onMoved(({ payload }: {payload: PhysicalPosition}) => {
    const scale = devicePixelRatio || 1;
    controller?.setHostPosition?.(payload.x / scale, payload.y / scale);
  });

  empty.addEventListener("click", () => {
    void invoke("open_settings");
  });

  const syncRendering = () => {
    const paused = pausedByTray || document.visibilityState !== "visible";
    animator?.setPaused(paused);
    if (paused) controller?.pause();
    else controller?.resume();
  };

  const beginOfflineCountdown = () => {
    connected = false;
    animator?.disconnected();
    void invoke("set_connection_state", { connected: false });
    bubble.hidden = true;
    void window.hide();
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      void invoke("exit_app");
    }, OFFLINE_EXIT_MS);
  };

  const remount = async () => {
    const generation = ++mountGeneration;
    const next = settings;
    animator?.disconnected(); animator = undefined;
    slot.destroy(); controller = undefined;
    host.replaceChildren(); empty.hidden = Boolean(next.model);
    if (!next.model) return;
    try {
      const mounted = await slot.mount(signal => mountModel(host, next, signal));
      if (!mounted || generation !== mountGeneration) return;
      controller = mounted;
      void window.outerPosition().then(position => {
        if (controller !== mounted) return;
        const scale = devicePixelRatio || 1;
        mounted.setHostPosition?.(position.x / scale, position.y / scale);
      }).catch(() => {});
      mounted.observeInteractionMask(mask => interaction.update(mask));
      animator = new StateAnimator(mounted, next.model.mappings);
      if (latestSnapshot) animator.apply(latestSnapshot);
      syncRendering();
    } catch {
      if (generation !== mountGeneration) return;
      empty.hidden = false;
      empty.textContent = "模型运行时加载失败，请打开设置检查模型。";
    }
  };
  globalThis.addEventListener("pagehide", () => { ++mountGeneration; stopMovement(); animator?.disconnected(); slot.destroy(); interaction.update(undefined); }, {once:true});
  await remount();

  const connection = new StatusConnection({
    onSnapshot(snapshot) {
      latestSnapshot = snapshot;
      animator?.apply(snapshot);
      renderBubble(bubble, snapshot, settings.preferences.privacyMode);
    },
    onConnected() {
      connected = true;
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = undefined;
      void invoke("set_connection_state", { connected: true });
      if (settings.model) void window.show();
      else void invoke("open_settings");
    },
    onDisconnected() {
      beginOfflineCountdown();
    },
  });

  const connectUrls = (urls: string[] | null | undefined) => {
    if (!urls) return;
    for (const url of urls) {
      try {
        connection.connect(url);
        // A valid deep link represents a DSH instance that should be reachable.
        // Start the fail-closed lifetime here so an initial connection failure
        // cannot leave an invisible tray process running forever.
        beginOfflineCountdown();
        return;
      } catch {
        // Invalid manually triggered links are ignored without exposing them.
      }
    }
  };
  connectUrls(await getCurrent());
  await onOpenUrl(connectUrls);

  await listen<DesktopSettings>("settings-changed", ({ payload }) => {
    settings = payload;
    if (latestSnapshot) renderBubble(bubble, latestSnapshot, settings.preferences.privacyMode);
    void remount()
      .then(() => {
        if (connected && settings.model) void window.show();
      })
      .catch(() => {
        empty.hidden = false;
        empty.textContent = "模型运行时加载失败，请打开设置检查模型。";
      });
  });
  await listen<string>("tray-action", ({ payload }) => {
    if (payload === "pause") pausedByTray = true;
    if (payload === "resume") pausedByTray = false;
    if (payload === "pause" || payload === "resume") syncRendering();
    if (payload === "reset") controller?.resetCamera();
  });
  document.addEventListener("visibilitychange", syncRendering);

  installPointerBehavior(host, {
    begin: (x, y) => invoke("begin_model_drag", {x,y}),
    move: () => invoke("move_model_drag"),
    end: () => invoke("end_model_drag"),
  }, () => animator?.click(), (x, y) => interaction.hitTest(x, y), () => { void invoke("open_settings"); });
  await keepWindowVisible(window);
}

export function renderBubble(
  element: HTMLOutputElement,
  snapshot: PetSnapshot,
  privacyMode: boolean,
): void {
  const text = privacyMode ? FIXED_BUBBLES[snapshot.state] : snapshot.bubble?.text;
  if (!text || snapshot.state === "idle") {
    element.hidden = true;
    element.textContent = "";
    delete element.dataset.bubbleKind;
    return;
  }
  let content = element.querySelector<HTMLSpanElement>(".bubble-content");
  if (!content) {
    content = document.createElement("span");
    content.className = "bubble-content";
    element.replaceChildren(content);
  }
  content.textContent = text;
  element.dataset.bubbleKind = privacyMode ? "notice" : snapshot.bubble?.kind ?? "notice";
  element.hidden = false;
}

export function installPointerBehavior(
  element: HTMLElement,
  drag: {begin: (x: number, y: number) => Promise<unknown>; move: () => Promise<unknown>; end: () => Promise<unknown>},
  click: () => void | Promise<void>,
  hitTest: (x: number, y: number) => boolean,
  openSettings?: () => void,
): void {
  let gesture: {id: number; x: number; y: number; moved: boolean; queued: boolean; chain: Promise<unknown>} | undefined;
  let finishing = false;
  element.addEventListener("contextmenu", event => {
    if (!openSettings || !hitTest(event.clientX, event.clientY)) return;
    event.preventDefault(); openSettings();
  });
  const finish = (event: PointerEvent, cancelled: boolean) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    gesture = undefined;
    finishing = true;
    current.moved ||= Math.hypot(event.screenX-current.x,event.screenY-current.y)>=5;
    if (element.hasPointerCapture(current.id)) element.releasePointerCapture(current.id);
    void current.chain.then(async () => {
      if (current.moved && !cancelled) await drag.move();
      if (!current.moved && !cancelled) void click();
    }).finally(() => drag.end()).finally(() => {finishing=false}).catch(() => {});
  };
  element.addEventListener("pointerdown", (event) => {
    if (gesture || finishing || event.button !== 0 || !hitTest(event.clientX, event.clientY)) return;
    gesture = {id:event.pointerId,x:event.screenX,y:event.screenY,moved:false,queued:false,chain:drag.begin(event.clientX,event.clientY)};
    // Attach rejection handling immediately while retaining the rejected chain.
    void gesture.chain.catch(() => {});
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    const current=gesture;
    if (!current || event.pointerId !== current.id || current.queued) return;
    if (!current.moved && Math.hypot(event.screenX-current.x,event.screenY-current.y)<5) return;
    current.moved=true;current.queued=true;
    current.chain=current.chain.then(()=>drag.move()).finally(()=>{current.queued=false});
    void current.chain.catch(() => {});
  });
  element.addEventListener("pointerup", event=>finish(event,false));
  element.addEventListener("pointercancel", event=>finish(event,true));
}

async function keepWindowVisible(window: Window): Promise<void> {
  try {
    const [position, size, monitors] = await Promise.all([
      window.outerPosition(),
      window.outerSize(),
      availableMonitors(),
    ]);
    const visible = (monitors as Monitor[]).some((monitor) => {
      const left = Math.max(position.x, monitor.position.x);
      const top = Math.max(position.y, monitor.position.y);
      const right = Math.min(position.x + size.width, monitor.position.x + monitor.size.width);
      const bottom = Math.min(position.y + size.height, monitor.position.y + monitor.size.height);
      return right - left >= 64 && bottom - top >= 64;
    });
    if (!visible) {
      const primary = await primaryMonitor();
      if (primary) {
        await window.setPosition(new PhysicalPosition(
          primary.position.x + primary.size.width - size.width - 24,
          primary.position.y + primary.size.height - size.height - 48,
        ));
      }
    }
  } catch {
    // Window APIs can fail briefly during monitor or sleep transitions.
  }
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${id}`);
  return element as T;
}

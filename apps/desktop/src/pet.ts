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
import { mountModel } from "./renderer.js";
import { StateAnimator } from "./state-animator.js";

const OFFLINE_EXIT_MS = 60_000;
const FIXED_BUBBLES: Partial<Record<PetState, string>> = {
  thinking: "思考中…",
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
  let controller: WidgetController | undefined;
  let animator: StateAnimator | undefined;
  let latestSnapshot: PetSnapshot | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedByTray = false;
  let connected = false;

  empty.addEventListener("click", () => {
    void invoke("open_settings");
  });

  const syncRendering = () => {
    if (pausedByTray || document.visibilityState !== "visible") controller?.pause();
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
    animator = undefined;
    controller?.destroy();
    controller = undefined;
    host.replaceChildren();
    empty.hidden = Boolean(settings.model);
    if (!settings.model) return;
    controller = await mountModel(host, settings);
    if (controller) {
      animator = new StateAnimator(controller, settings.model.mappings);
      if (latestSnapshot) animator.apply(latestSnapshot);
      syncRendering();
    }
  };

  try {
    await remount();
  } catch {
    empty.hidden = false;
    empty.textContent = "模型运行时加载失败，请打开设置检查模型。";
  }

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

  installPointerBehavior(host, window.startDragging.bind(window), () => animator?.click());
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
    return;
  }
  element.textContent = text;
  element.hidden = false;
}

export function installPointerBehavior(
  element: HTMLElement,
  startDragging: () => Promise<void>,
  click: () => void | Promise<void>,
): void {
  let pointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let dragged = false;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragged = false;
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || dragged) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return;
    dragged = true;
    void startDragging();
  });
  element.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = undefined;
    if (!dragged) void click();
  });
  element.addEventListener("pointercancel", () => {
    pointerId = undefined;
  });
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

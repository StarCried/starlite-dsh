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
import { message } from "@tauri-apps/plugin-dialog";
import type { PetSnapshot, WidgetController } from "./vendor-types.js";
import type { DesktopSettings } from "./types.js";
import { StatusConnection } from "./connection.js";
import { createModelSlot, mountModel } from "./renderer.js";
import { renderingIdentity, selectedModel } from "./model-selection.js";
import { StateAnimator } from "./state-animator.js";
import { InteractionMaskBridge } from "./interaction-mask.js";
import { ModelViewportBridge } from "./model-viewport.js";
import { HostPositionBridge, screenSpaceAboveModel } from "./host-position.js";
import { BillingBubble, renderBillingBubble } from "./billing-bubble.js";
import {WorkBubble,renderPlainBubble} from "./work-bubble.js";
export {renderBubble} from "./work-bubble.js";

const OFFLINE_EXIT_MS = 60_000;

export async function startPet(): Promise<void> {
  const window = getCurrentWindow();
  const host = requiredElement("model");
  const bubble = requiredElement<HTMLOutputElement>("bubble");
  const empty = requiredElement("empty-model");
  const anchor = requiredElement("pet-view");
  let settings = await invoke<DesktopSettings>("get_settings");
  const modelAvailable = () => selectedModel(settings)?.backend === "vrm";
  const slot = await createModelSlot();
  let mountGeneration = 0;
  let controller: WidgetController | undefined;
  let animator: StateAnimator | undefined;
  let latestSnapshot: PetSnapshot | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedByTray = false;
  let connected = false;
  let closing = false;
  let connection: StatusConnection | undefined;
  let cancelClick=()=>{};
  let geometryQueue:Promise<unknown>=Promise.resolve();
  const geometryTask=<T>(operation:()=>Promise<T>):Promise<T>=>{
    const next=geometryQueue.catch(()=>{}).then(operation);
    geometryQueue=next;return next;
  };
  const geometryInvoke=(command:string,args:Record<string,unknown>)=>geometryTask(()=>invoke(command,args));
  type Region={left:number;top:number;width:number;height:number;viewportWidth:number;viewportHeight:number}|null;
  let regionPending:Region|undefined,regionSending=false;
  const sendRegion=async()=>{
    if(regionSending)return;regionSending=true;
    try{while(regionPending!==undefined){const region=regionPending;regionPending=undefined;await geometryInvoke("set_bubble_interaction_region",{region});}}
    catch{regionPending=undefined;void window.hide();void invoke("open_settings");}
    finally{regionSending=false;}
  };
  const updateRegion=()=>{
    const rect=bubble.getBoundingClientRect();
    const left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
    const region=!bubble.hidden&&bubble.dataset.interactive==="true"&&document.visibilityState==="visible"&&right>left&&bottom>top
      ?{left,top,width:right-left,height:bottom-top,viewportWidth:innerWidth,viewportHeight:innerHeight}:null;
    regionPending=region;void sendRegion();
  };
  let availabilityQueue=Promise.resolve();
  const syncInputAvailable=()=>{
    availabilityQueue=availabilityQueue.catch(()=>{}).then(async()=>{
      if(connected)await connection?.setInputAvailable(modelAvailable()&&!settings.preferences.privacyMode&&document.visibilityState==="visible");
    }).catch(()=>{});
  };
  const workBubble=new WorkBubble(bubble,{
    read:id=>connection!.readInteraction(id),answer:value=>connection!.answerInteraction(value),
    open:ref=>connection!.openSession(ref),
    delegate:async()=>{await connection!.setInputAvailable(false);syncInputAvailable();},
    changed:updateRegion,
  });
  const bubbleObserver=new ResizeObserver(updateRegion);bubbleObserver.observe(bubble);
  const fees = new BillingBubble({
    read: async () => {
      if (!connection) throw new Error("billing disconnected");
      return connection.readBilling();
    },
    allowed: () => connected && modelAvailable() && !settings.preferences.privacyMode && !latestSnapshot?.inputRequest,
    render: view => {renderBillingBubble(bubble, view,latestSnapshot?.session?.title);updateRegion();},
    restore: () => {
      if (latestSnapshot && modelAvailable()) workBubble.update(latestSnapshot, settings.preferences);
      else bubble.hidden = true;
    },
  });
  const interaction = new InteractionMaskBridge(
    mask => geometryInvoke("set_model_hit_mask", {mask}),
    () => { void window.hide(); void invoke("open_settings"); },
  );
  const readPosition=async()=>{
    const [position,monitors]=await Promise.all([window.outerPosition(),availableMonitors()]);
    return {x:position.x,y:position.y,monitors,scale:devicePixelRatio||1};
  };
  const hostPosition=new HostPositionBridge(
    readPosition,
    ()=>!closing&&Boolean(controller)&&!viewport.pending,
    position=>{
      const point=viewport.hostPosition(position,position.scale);
      controller?.setHostPosition?.(point.x,point.y);
      const space=screenSpaceAboveModel(point,position.scale,position.monitors);
      if(space!==undefined)viewport.setScreenSpace(space);
    },
  );
  const viewport = new ModelViewportBridge(host,anchor,
    value=>geometryInvoke("set_model_viewport",{viewport:value}),
    ()=>{hostPosition.invalidate();interaction.invalidateForViewport();regionPending=null;},
    ()=>{updateRegion();void hostPosition.sync().catch(()=>{});},
    ()=>{void window.hide();void invoke("open_settings");},
    bubble,updateRegion,
  );
  await listen<{x: number; y: number}>("pet-cursor", ({payload}) => {
    controller?.setPointerPosition(payload.x, payload.y);
  });
  const stopMovement = await window.onMoved(() => {
    void hostPosition.sync().catch(()=>{});
  });

  empty.addEventListener("click", () => {
    void invoke("open_settings");
  });

  const syncRendering = () => {
    const paused = !modelAvailable() || pausedByTray || document.visibilityState !== "visible";
    animator?.setPaused(paused);
    if (paused) controller?.pause();
    else controller?.resume();
    syncInputAvailable();updateRegion();
  };
  // A fast initial connection can show the hidden window before later native
  // subscriptions resolve. Observe that first visibility change before mount.
  document.addEventListener("visibilitychange", syncRendering);

  const beginOfflineCountdown = () => {
    connected = false;
    fees.cancel();
    cancelClick();workBubble.clear();
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
    hostPosition.invalidate();
    const next = settings;
    const model = selectedModel(next);
    const enabled = model?.backend === "vrm";
    fees.cancel(); cancelClick(); workBubble.clear(); bubble.hidden = true;
    animator?.disconnected(); animator = undefined;
    slot.destroy(); controller = undefined;
    interaction.update(undefined);
    if (!enabled) void window.hide();
    await viewport.configure(enabled);
    if(generation!==mountGeneration)return;
    host.replaceChildren(); empty.hidden = !enabled || Boolean(model);
    syncInputAvailable();
    if (!enabled || !model) return;
    try {
      const mounted = await slot.mount(signal => mountModel(host, next, signal));
      if (!mounted || generation !== mountGeneration) return;
      await viewport.ready();
      if(generation!==mountGeneration)return;
      controller = mounted;
      void hostPosition.sync().catch(()=>{});
      mounted.observeInteractionMask(mask => {
        // A frame drawn before the native resize still describes the old
        // viewport. Wait for fresh coverage instead of stretching that mask.
        if(viewport.pending || mask && (mask.viewportWidth!==innerWidth || mask.viewportHeight!==innerHeight))return;
        interaction.update(mask);
      });
      animator = new StateAnimator(mounted, model.mappings);
      if (latestSnapshot) animator.apply(latestSnapshot);
      if (latestSnapshot && !fees.visible) workBubble.update(latestSnapshot, next.preferences);
      syncRendering();
    } catch {
      if (generation !== mountGeneration) return;
      empty.hidden = false;
      empty.textContent = "模型运行时加载失败，请打开设置检查模型。";
    }
  };
  globalThis.addEventListener("pagehide", () => { closing=true; ++mountGeneration; document.removeEventListener("visibilitychange",syncRendering); hostPosition.invalidate(); stopMovement(); cancelClick(); fees.cancel(); bubbleObserver.disconnect(); workBubble.clear(); connection?.stop(); animator?.disconnected(); slot.destroy(); interaction.update(undefined); void viewport.destroy(); }, {once:true});
  let settingsRevision = 0;
  let preparing = true;
  await listen<DesktopSettings>("settings-changed", ({ payload }) => {
    ++settingsRevision;
    const previous=settings;
    settings = payload;
    fees.cancel();
    if (latestSnapshot && modelAvailable()) workBubble.update(latestSnapshot, settings.preferences);
    else workBubble.clear();
    syncInputAvailable();
    if (preparing) return;
    if (renderingIdentity(previous) === renderingIdentity(settings)) {
      const model = selectedModel(settings);
      if (controller && model && JSON.stringify(selectedModel(previous)?.mappings) !== JSON.stringify(model.mappings)) {
        animator?.disconnected();
        animator = new StateAnimator(controller, model.mappings);
        if (latestSnapshot) animator.apply(latestSnapshot);
        syncRendering();
      }
      return;
    }
    void remount()
      .then(() => {
        if (connected && modelAvailable() && controller) void window.show();
      })
      .catch(() => {
        empty.hidden = false;
        empty.textContent = "模型运行时加载失败，请打开设置检查模型。";
      });
  });
  // Native preparation is idempotent, serializes with settings mutations and
  // preserves an installed user VRM. Never wait for a first-use settings UI.
  const readRevision = settingsRevision;
  try {
    const currentSettings = await invoke<DesktopSettings>("prepare_model");
    if (readRevision === settingsRevision) settings = currentSettings;
  } catch {
    void invoke("open_settings");
  } finally { preparing = false; }
  await remount();

  connection = new StatusConnection({
    onSnapshot(snapshot) {
      if(snapshot.session?.ref!==latestSnapshot?.session?.ref || snapshot.inputRequest!==latestSnapshot?.inputRequest){fees.cancel();cancelClick();}
      latestSnapshot = snapshot;
      animator?.apply(snapshot);
      fees.stateChanged(snapshot.state);
      if (!fees.visible && modelAvailable()) workBubble.update(snapshot, settings.preferences);
    },
    onConnected() {
      connected = true;
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = undefined;
      void invoke("set_connection_state", { connected: true });
      if (modelAvailable() && controller) void window.show();
      else if (settings.activeModelId !== null) void invoke("open_settings");
      syncInputAvailable();
    },
    onDisconnected() {
      beginOfflineCountdown();
    },
    onConflict() {
      void message("桌宠已连接另一个 DSH Host，本次不会切换。\n\n要切换到当前 Host，请先停止原 DSH，等待 StarLite 托盘图标退出后，再重新启动当前 DSH。断线检测最多 45 秒，随后保留 60 秒重连期。", {title:"StarLite for DSH · 连接未切换",kind:"info"}).catch(()=>{});
    },
  });

  const connectUrls = (urls: string[] | null | undefined) => {
    if (!urls) return;
    for (const url of urls) {
      try {
        const admission = connection?.connect(url);
        if (admission !== "accepted") return;
        fees.cancel();
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

  await listen<string>("tray-action", ({ payload }) => {
    if (payload === "pause") pausedByTray = true;
    if (payload === "resume") pausedByTray = false;
    if (payload === "pause" || payload === "resume") syncRendering();
    if (payload === "reset") controller?.resetCamera();
  });
  cancelClick=installPointerBehavior(host, {
    begin: (x, y) => invoke("begin_model_drag",{x,y}),
    move: () => invoke("move_model_drag"),
    end: async () => {
      try{return await invoke("end_model_drag");}
      finally{void hostPosition.sync().catch(()=>{});}
    },
  }, () => {void fees.show(); void animator?.click();}, (x, y) => interaction.hitTest(x, y), () => { void invoke("open_settings"); },()=>{
    const ref=latestSnapshot?.session?.ref;
    if(!connected||!connection)return;
    void openDisplayedDsh(connection,ref).catch(()=>{
      if(latestSnapshot?.session?.ref===ref&&!latestSnapshot?.inputRequest){renderPlainBubble(bubble,ref?"暂时无法打开 DSH 会话":"暂时无法打开 DSH Web UI","notice",settings.preferences.privacyMode?"DSH":latestSnapshot?.session?.title);updateRegion();}
    });
  });
  await keepWindowVisible(window);
}

export function openDisplayedDsh(connection: Pick<StatusConnection,"openSession"|"openWebUi">, sessionRef?: string): Promise<void> {
  return sessionRef ? connection.openSession(sessionRef) : connection.openWebUi();
}

export function installPointerBehavior(
  element: HTMLElement,
  drag: {begin: (x: number, y: number) => Promise<unknown>; move: () => Promise<unknown>; end: () => Promise<unknown>},
  click: () => void | Promise<void>,
  hitTest: (x: number, y: number) => boolean,
  openSettings?: () => void,
  doubleClick?: () => void | Promise<void>,
): () => void {
  let gesture: {id: number; x: number; y: number; moved: boolean; queued: boolean; chain: Promise<unknown>} | undefined;
  let dragTail:Promise<unknown>=Promise.resolve();
  let clickEpoch=0;
  let clickTimer:ReturnType<typeof setTimeout>|undefined;
  let firstClick:{x:number;y:number;ready:Promise<unknown>}|undefined;
  const clearClick=()=>{if(clickTimer)clearTimeout(clickTimer);clickTimer=undefined;firstClick=undefined;};
  const cancel=()=>{++clickEpoch;clearClick();};
  const whenReady=(ready:Promise<unknown>,action:()=>void|Promise<void>,epoch:number)=>{
    void ready.then(async()=>{if(epoch===clickEpoch)await action();}).catch(()=>{});
  };
  const completeClick=(event:PointerEvent,ready:Promise<unknown>)=>{
    const epoch=clickEpoch;
    if(!doubleClick){whenReady(ready,click,epoch);return;}
    if(clickTimer&&firstClick&&Math.hypot(event.screenX-firstClick.x,event.screenY-firstClick.y)<6){const prior=firstClick.ready;clearClick();whenReady(Promise.all([prior,ready]),doubleClick,epoch);return;}
    clearClick();firstClick={x:event.screenX,y:event.screenY,ready};clickTimer=setTimeout(()=>{clearClick();whenReady(ready,click,epoch);},350);
  };
  element.addEventListener("contextmenu", event => {
    if (!openSettings || !hitTest(event.clientX, event.clientY)) return;
    cancel();
    event.preventDefault(); openSettings();
  });
  const finish = (event: PointerEvent, cancelled: boolean) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    gesture = undefined;
    current.moved ||= Math.hypot(event.screenX-current.x,event.screenY-current.y)>=5;
    if (element.hasPointerCapture(current.id)) element.releasePointerCapture(current.id);
    if(current.moved||cancelled)cancel();else completeClick(event,current.chain);
    dragTail = current.chain.then(async () => {
      if (current.moved && !cancelled) await drag.move();
    }).finally(() => drag.end()).catch(() => {});
  };
  element.addEventListener("pointerdown", (event) => {
    if (gesture || event.button !== 0 || !hitTest(event.clientX, event.clientY)) return;
    gesture = {id:event.pointerId,x:event.screenX,y:event.screenY,moved:false,queued:false,chain:dragTail.then(()=>drag.begin(event.clientX,event.clientY))};
    // Attach rejection handling immediately while retaining the rejected chain.
    void gesture.chain.catch(() => {});
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    const current=gesture;
    if (!current || event.pointerId !== current.id || current.queued) return;
    if (!current.moved && Math.hypot(event.screenX-current.x,event.screenY-current.y)<5) return;
    current.moved=true;current.queued=true;
    cancel();
    current.chain=current.chain.then(()=>drag.move()).finally(()=>{current.queued=false});
    void current.chain.catch(() => {});
  });
  element.addEventListener("pointerup", event=>finish(event,false));
  element.addEventListener("pointercancel", event=>finish(event,true));
  return cancel;
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

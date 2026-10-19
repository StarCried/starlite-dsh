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
import {parsePetConnectionUrl} from "@starcried/starlite-dsh-protocol";
import type { PetSnapshot, WidgetController } from "./vendor-types.js";
import type { DesktopSettings } from "./types.js";
import { StatusConnection } from "./connection.js";
import { createModelSlot, createQuickMenu, mountModel } from "./renderer.js";
import {createPetQuickMenu, type PetUiState, type PetQuickMenu} from "./quick-settings.js";
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
  let closing = false;
  let connectLive: ((urls: string[]) => void) | undefined;
  const earlyUrls = new Map<string, string>();
  let removeDeepLinks: (() => void) | undefined;
  // Subscribe before model preparation. Native state separately preserves the
  // first valid launch even before this WebView exists.
  const deepLinksReady = onOpenUrl(urls => {
    if (closing) return;
    if (connectLive) {connectLive(urls); return;}
    for (const url of urls) {
      try {
        const descriptor = parsePetConnectionUrl(url);
        const identity = `${descriptor.instanceId}:${descriptor.port}:${descriptor.token}`;
        if (!earlyUrls.has(identity) && earlyUrls.size < 2) earlyUrls.set(identity, url);
      } catch { /* Invalid launches cannot occupy the bounded startup buffer. */ }
    }
  }).then(remove => {if (closing) remove(); else removeDeepLinks = remove;});
  void deepLinksReady.catch(() => undefined);
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
  let ui:PetUiState={paused:false,visible:true,clickThrough:false};
  let quickMenu:PetQuickMenu|undefined;
  let menuOpenGeneration=0;
  let connected = false;
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
  let menuRegionPending:Region|undefined,menuRegionSending=false;
  const updateMenuRegion=()=>{
    const rect=quickMenu?.element.getBoundingClientRect();
    const left=Math.max(0,rect?.left??0),top=Math.max(0,rect?.top??0),right=Math.min(innerWidth,rect?.right??0),bottom=Math.min(innerHeight,rect?.bottom??0);
    menuRegionPending=quickMenu?.isOpen&&document.visibilityState==="visible"&&right>left&&bottom>top
      ?{left,top,width:right-left,height:bottom-top,viewportWidth:innerWidth,viewportHeight:innerHeight}:null;
    if(menuRegionSending)return;
    menuRegionSending=true;
    void (async()=>{
      try{while(menuRegionPending!==undefined){const region=menuRegionPending;menuRegionPending=undefined;await geometryInvoke("set_menu_interaction_region",{region});}}
      catch{quickMenu?.close();}
      finally{menuRegionSending=false;}
    })();
  };
  let availabilityQueue=Promise.resolve();
  const syncInputAvailable=()=>{
    availabilityQueue=availabilityQueue.catch(()=>{}).then(async()=>{
      if(connected)await connection?.setInputAvailable(modelAvailable()&&ui.visible&&!ui.clickThrough&&settings.preferences.bubblesVisible!==false&&!settings.preferences.privacyMode&&document.visibilityState==="visible");
    }).catch(()=>{});
  };
  const workBubble=new WorkBubble(bubble,{
    read:id=>connection!.readInteraction(id),answer:value=>connection!.answerInteraction(value),
    open:ref=>connection!.openSession(ref),
    changed:updateRegion,
  });
  const bubbleObserver=new ResizeObserver(updateRegion);bubbleObserver.observe(bubble);
  const fees = new BillingBubble({
    read: async () => {
      if (!connection) throw new Error("billing disconnected");
      return connection.readBilling();
    },
    allowed: () => connected && modelAvailable() && settings.preferences.bubblesVisible!==false && !settings.preferences.privacyMode && !latestSnapshot?.inputRequest,
    render: view => {if(settings.preferences.bubblesVisible!==false)renderBillingBubble(bubble, view,latestSnapshot?.session?.title);else bubble.hidden=true;updateRegion();},
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
    return {x:position.x,y:position.y,monitors:monitors as Monitor[],scale:devicePixelRatio||1};
  };
  const fitQuickMenu=async()=>{
    if(!quickMenu?.isOpen)return;
    const position=await readPosition();
    if(!quickMenu?.isOpen)return;
    const dpi=position.scale,rect=quickMenu.element.getBoundingClientRect();
    const point={x:position.x+(rect.left+rect.width/2)*dpi,y:position.y+(rect.top+rect.height/2)*dpi};
    const monitor=position.monitors.find(m=>point.x>=m.position.x&&point.x<m.position.x+m.size.width&&point.y>=m.position.y&&point.y<m.position.y+m.size.height)??position.monitors[0];
    if(!monitor)return;
    const area=monitor.workArea;
    const left=Math.max(0,(area.position.x-position.x)/dpi)+8,top=Math.max(0,(area.position.y-position.y)/dpi)+8;
    const right=Math.min(innerWidth,(area.position.x+(area.size?.width??monitor.size.width)-position.x)/dpi)-8;
    const bottom=Math.min(innerHeight,(area.position.y+(area.size?.height??monitor.size.height)-position.y)/dpi)-8;
    const style=quickMenu.element.style;
    const assign=(key:"maxWidth"|"maxHeight"|"left"|"top",value:string)=>{if(style[key]!==value)style[key]=value;};
    assign("maxWidth",`${Math.max(0,right-left)}px`);
    assign("maxHeight",`${Math.max(0,bottom-top)}px`);
    const next=quickMenu.element.getBoundingClientRect();
    const x=Math.max(left,Math.min(next.left,right-next.width)),y=Math.max(top,Math.min(next.top,bottom-next.height));
    assign("left",`${x}px`);
    assign("top",`${y}px`);
    // Expanded tabs/dropdowns scroll inside the space below this fixed anchor.
    assign("maxWidth",`${Math.max(0,right-x)}px`);
    assign("maxHeight",`${Math.max(0,bottom-y)}px`);
    updateMenuRegion();
  };
  const hostPosition=new HostPositionBridge(
    readPosition,
    ()=>!closing&&Boolean(controller)&&!viewport.pending,
    position=>{
      const point=viewport.hostPosition(position,position.scale);
      controller?.setHostPosition?.(point.x,point.y);
      const space=screenSpaceAboveModel(point,position.scale,position.monitors,viewport.modelRect);
      if(space!==undefined)viewport.setScreenSpace(space);
    },
  );
  const viewport = new ModelViewportBridge(host,anchor,
    value=>geometryInvoke("set_model_viewport",{viewport:value}),
    ()=>{hostPosition.invalidate();interaction.invalidateForViewport();regionPending=null;menuRegionPending=null;},
    ()=>{updateRegion();updateMenuRegion();void hostPosition.sync().catch(()=>{});},
    ()=>{void window.hide();void invoke("open_settings");},
    bubble,updateRegion,
  );
  await listen<{x: number; y: number}>("pet-cursor", ({payload}) => {
    controller?.setPointerPosition(payload.x, payload.y);
  });
  const stopMovement = await window.onMoved(() => {
    void hostPosition.sync().catch(()=>{});
  });
  const syncWindowGeometry = () => {
    if (closing) return;
    if (modelAvailable()) interaction.resizeFixedViewport(innerWidth,innerHeight);
    updateRegion();
    updateMenuRegion();
    void hostPosition.sync().catch(()=>{});
  };
  globalThis.addEventListener("resize",syncWindowGeometry);

  empty.addEventListener("click", () => {
    void invoke("open_settings");
  });

  const syncRendering = () => {
    const paused = !modelAvailable() || !ui.visible || pausedByTray || document.visibilityState !== "visible";
    animator?.setPaused(paused);
    if (paused) controller?.pause();
    else controller?.resume();
    if(document.visibilityState!=="visible")quickMenu?.close();
    syncInputAvailable();updateRegion();updateMenuRegion();
  };
  // A fast initial connection can show the hidden window before later native
  // subscriptions resolve. Observe that first visibility change before mount.
  document.addEventListener("visibilitychange", syncRendering);

  const beginOfflineCountdown = () => {
    connected = false;
    quickMenu?.close();
    fees.cancel();
    cancelClick();workBubble.clear();
    animator?.disconnected();
    void invoke("set_connection_state", { connected: false });
    bubble.hidden = true;
    void window.hide();
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = undefined;
      if (!closing && connection?.connectPending()) {beginOfflineCountdown(); return;}
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
    await viewport.configure(enabled,next.preferences.scale);
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
      mounted.setPerformanceVisible?.(settings.preferences.performanceOverlay);
      mounted.setPointerEnabled?.(settings.preferences.pointerEnabled!==false);
      mounted.setBubblesVisible?.(false);
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
  const menuResize=new ResizeObserver(updateMenuRegion);
  const menuMutation=new MutationObserver(updateMenuRegion);
  const syncMenuSurface=()=>{
    const open=quickMenu?.isOpen===true;
    if(!open)++menuOpenGeneration;
    void viewport.reserveMenuSpace(open).then(()=>{controller?.refreshInteractionMask?.();updateMenuRegion();}).catch(()=>{});
    updateMenuRegion();
  };
  const closeQuickMenu=()=>{++menuOpenGeneration;quickMenu?.close();syncMenuSurface();};
  globalThis.addEventListener("blur",closeQuickMenu);
  globalThis.addEventListener("pagehide", () => { closing=true; if(offlineTimer)clearTimeout(offlineTimer); connectLive=undefined; earlyUrls.clear(); removeDeepLinks?.(); ++mountGeneration; document.removeEventListener("visibilitychange",syncRendering); globalThis.removeEventListener("resize",syncWindowGeometry);globalThis.removeEventListener("blur",closeQuickMenu); hostPosition.invalidate(); stopMovement(); cancelClick(); fees.cancel(); bubbleObserver.disconnect(); menuResize.disconnect();menuMutation.disconnect();quickMenu?.destroy();void geometryInvoke("set_menu_interaction_region",{region:null});workBubble.clear(); connection?.stop(); animator?.disconnected(); slot.destroy(); interaction.update(undefined); void viewport.destroy(); }, {once:true});
  let settingsRevision = 0;
  let preparing = true;
  await listen<DesktopSettings>("settings-changed", ({ payload }) => {
    ++settingsRevision;
    const previous=settings;
    settings = payload;
    quickMenu?.refresh();
    fees.cancel();
    if (latestSnapshot && modelAvailable()) workBubble.update(latestSnapshot, settings.preferences);
    else workBubble.clear();
    syncInputAvailable();
    if (preparing) return;
    if (renderingIdentity(previous) === renderingIdentity(settings)) {
      controller?.setFrameRate?.(settings.preferences.fps);
      controller?.setPointerEnabled?.(settings.preferences.pointerEnabled!==false);
      if(previous.preferences.scale!==settings.preferences.scale){
        const scale=settings.preferences.scale;
        void viewport.configure(modelAvailable(),scale).then(()=>{
          if(settings.preferences.scale!==scale)return;
          controller?.setDisplaySize?.(320*scale,480*scale);
          controller?.refreshInteractionMask?.();
        }).catch(()=>{});
      }
      if (previous.preferences.performanceOverlay !== settings.preferences.performanceOverlay) {
        controller?.setPerformanceVisible?.(settings.preferences.performanceOverlay);
      }
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
        if (connected && ui.visible && modelAvailable() && controller) void window.show();
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
      if (ui.visible && modelAvailable() && controller) void window.show();
      else if (settings.activeModelId !== null && (!modelAvailable() || !controller)) void invoke("open_settings");
      syncInputAvailable();
    },
    onDisconnected() {
      beginOfflineCountdown();
    },
    onConflict() {
      void message("桌宠已连接另一个 DSH Host，当前不会切换。\n\n已保留第一个等待连接的 Host。原 Host 停止且 60 秒重连期结束后会自动连接，无需重新启动 DSH；原 Host 恢复则继续使用原连接。停滞连接最多需要 45 秒检测。后续启动不会覆盖等待中的 Host。", {title:"StarLite for DSH · 等待连接",kind:"info"}).catch(()=>{});
    },
  });

  const connectUrls = (urls: string[] | null | undefined) => {
    if (closing || !urls) return;
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
  const initial = await invoke<string | null>("get_initial_connection");
  if (initial) connectUrls([initial]);
  await deepLinksReady;
  if (closing) return;
  // A manual initial launch may acquire its first URL during listener setup.
  const remembered = await invoke<string | null>("get_initial_connection");
  if (remembered) connectUrls([remembered]);
  for (const url of earlyUrls.values()) connectUrls([url]);
  earlyUrls.clear();
  connectLive = connectUrls;
  connectUrls(await getCurrent());

  await listen<string>("tray-action", ({ payload }) => {
    if (payload === "pause") pausedByTray = true;
    if (payload === "resume") pausedByTray = false;
    if (payload === "pause" || payload === "resume") syncRendering();
    if (payload === "reset") controller?.resetCamera();
  });
  await listen<PetUiState>("pet-ui-state",({payload})=>{
    ui=payload;pausedByTray=payload.paused;
    quickMenu?.refresh();
    if(!payload.visible||payload.clickThrough)quickMenu?.close();
    syncRendering();
  });
  ui=await invoke<PetUiState>("get_pet_ui_state");pausedByTray=ui.paused;syncRendering();
  quickMenu=await createPetQuickMenu(createQuickMenu,{
    readSettings:()=>settings,readUi:()=>ui,
    patch:async patch=>{await invoke("patch_preferences",{patch});},
    pause:async paused=>{await invoke("set_pet_paused",{paused});},
    hide:async()=>{await invoke("set_pet_visible",{visible:false});},
    restorePosition:async()=>{await geometryTask(()=>invoke("restore_default_position",{modelRect:viewport.modelRect}));void hostPosition.sync().catch(()=>{});},
    openSettings:async()=>{await invoke("open_settings");},
    openDsh:async()=>{if(connection&&connected)await openDisplayedDsh(connection,latestSnapshot?.session?.ref);},
    selectModel:async modelId=>{await invoke("select_model",{modelId});},
  });
  quickMenu.element.addEventListener("starlite-menu-change",syncMenuSurface);
  menuResize.observe(quickMenu.element);
  menuMutation.observe(quickMenu.element,{attributes:true,childList:true,subtree:true});
  cancelClick=installPointerBehavior(host, {
    begin: (x, y) => invoke("begin_model_drag",{x,y}),
    move: () => invoke("move_model_drag"),
    end: async () => {
      try{return await invoke("end_model_drag");}
      finally{void hostPosition.sync().catch(()=>{});}
    },
  }, () => {void fees.show(); void animator?.click();}, (x, y) => interaction.hitTest(x, y), (x,y) => {
    const generation=++menuOpenGeneration;
    void viewport.reserveMenuSpace(true).then(async()=>{
      if(closing||generation!==menuOpenGeneration)return;
      quickMenu?.open(x,y);
      await fitQuickMenu();
      controller?.refreshInteractionMask?.();updateMenuRegion();
    }).catch(()=>{});
  },()=>{
    const ref=latestSnapshot?.session?.ref;
    if(!connected||!connection)return;
    void openDisplayedDsh(connection,ref).catch(()=>{
      if(settings.preferences.bubblesVisible!==false&&latestSnapshot?.session?.ref===ref&&!latestSnapshot?.inputRequest){renderPlainBubble(bubble,ref?"暂时无法打开 DSH 会话":"暂时无法打开 DSH","notice",settings.preferences.privacyMode?"DSH":latestSnapshot?.session?.title);updateRegion();}
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
  openSettings?: (x:number,y:number) => void,
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
    event.preventDefault(); openSettings(event.clientX,event.clientY);
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

import { t, uiLocale } from "./i18n.js";
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
import {parsePetConnectionUrl, type ControlDesktopReport} from "@starcried/starlite-dsh-protocol";
import type { PetSnapshot, WidgetController } from "./vendor-types.js";
import type { DesktopSettings, ModelAdjustments } from "./types.js";
import { StatusConnection } from "./connection.js";
import { createModelSlot, createQuickMenu, createVisitorToolbar, loadModelDragGesture, mountModel } from "./renderer.js";
import {PetVisitorToolbar, portraitWithToolbar, steppedPetScale} from "./visitor-toolbar.js";
import {createPetQuickMenu, type PetUiState, type PetQuickMenu} from "./quick-settings.js";
import {menuWorkArea} from "./menu-placement.js";
import { renderingIdentity, selectedModel } from "./model-selection.js";
import { StateAnimator } from "./state-animator.js";
import { InteractionMaskBridge } from "./interaction-mask.js";
import { ModelViewportBridge } from "./model-viewport.js";
import { EnvironmentLightingBridge, type EnvironmentColor } from "./environment-lighting.js";
import { EnvironmentSamplingOverlay } from "./environment-debug.js";
import { HostPositionBridge, screenSpaceAboveModel } from "./host-position.js";
import { BillingBubble, renderBillingBubble } from "./billing-bubble.js";
import {WorkBubble,renderPlainBubble} from "./work-bubble.js";
import {SessionPresenter} from "./session-presenter.js";
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
  const samplingOverlay = new EnvironmentSamplingOverlay(t("环境光采样区域"));
  const environmentLighting = new EnvironmentLightingBridge(
    async () => {
      // The normal click mask is throttled. A fresh pose avoids sampling into
      // a fast-moving arm, and ready() includes coalesced native mask writes.
      controller?.refreshInteractionMask?.();
      await interaction.ready();
      const overlays=samplingOverlay.exclusions();
      const sample=await invoke<EnvironmentColor | null>("sample_environment_color",{overlays});
      // A menu or bubble can change while native work is queued. Its old
      // exclusion layout must not be used to apply a self-contaminated color.
      return samplingOverlay.matches(overlays)?sample:null;
    },
    sample => samplingOverlay.update(sample),
  );
  let animator: StateAnimator | undefined;
  let latestSnapshot: PetSnapshot | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pausedByTray = false;
  let ui:PetUiState={paused:false,visible:true,clickThrough:false};
  let quickMenu:PetQuickMenu|undefined;
  let visitorToolbar:PetVisitorToolbar|undefined;
  let resetHostMotion=false;
  let menuOpenGeneration=0;
  let connected = false;
  let connection: StatusConnection | undefined;
  let presenter:SessionPresenter|undefined;
  let modelRevision:string|undefined;
  let temporaryScale:number|undefined;
  let temporaryPointer:boolean|undefined;
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
    // Toolbar and full menu are mutually exclusive; never bridge their empty
    // surroundings with one oversized native rectangle.
    const visible=ui.visible&&!ui.clickThrough&&!viewport.pending&&(quickMenu?.isOpen||visitorToolbar?.visible);
    const controls=visitorToolbar?.visible?visitorToolbar.rect:undefined;
    const rect=quickMenu?.isOpen?quickMenu.element.getBoundingClientRect():controls;
    const bounds=rect?{left:rect.left,top:rect.top,right:rect.left+rect.width,bottom:rect.top+rect.height}:undefined;
    const left=Math.max(0,bounds?.left??0),top=Math.max(0,bounds?.top??0),right=Math.min(innerWidth,bounds?.right??0),bottom=Math.min(innerHeight,bounds?.bottom??0);
    menuRegionPending=visible&&document.visibilityState==="visible"&&right>left&&bottom>top
      ?{left,top,width:right-left,height:bottom-top,viewportWidth:innerWidth,viewportHeight:innerHeight}:null;
    if(menuRegionSending)return;
    menuRegionSending=true;
    void (async()=>{
      try{while(menuRegionPending!==undefined){const region=menuRegionPending;menuRegionPending=undefined;await geometryInvoke("set_menu_interaction_region",{region});}}
      catch{quickMenu?.close();visitorToolbar?.clear();}
      finally{menuRegionSending=false;}
    })();
  };
  let availabilityQueue=Promise.resolve();
  const syncInputAvailable=()=>{
    availabilityQueue=availabilityQueue.catch(()=>{}).then(async()=>{
      if(connected)await connection?.setInputAvailable(!presenter?.busy&&modelAvailable()&&ui.visible&&!ui.clickThrough&&settings.preferences.bubblesVisible!==false&&!settings.preferences.privacyMode&&document.visibilityState==="visible");
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
    allowed: () => !presenter?.busy && connected && modelAvailable() && settings.preferences.bubblesVisible!==false && !settings.preferences.privacyMode && !latestSnapshot?.inputRequest,
    render: view => {if(settings.preferences.bubblesVisible!==false)renderBillingBubble(bubble, view,latestSnapshot?.session?.title);else bubble.hidden=true;updateRegion();},
    restore: () => {
      if (!presenter?.busy && latestSnapshot && modelAvailable()) workBubble.update(latestSnapshot, settings.preferences);
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
  const fitQuickMenu=(pointer:{x:number;y:number},position:Awaited<ReturnType<typeof readPosition>>)=>{
    if(!quickMenu?.isOpen)return;
    const bounds=menuWorkArea(position,position.scale,{width:innerWidth,height:innerHeight},pointer,position.monitors);
    if(!bounds){quickMenu.close();return;}
    const {left,top,right,bottom}=bounds;
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
      controller?.setHostPosition?.(point.x,point.y,resetHostMotion?{resetMotion:true}:undefined);
      resetHostMotion=false;
      const space=screenSpaceAboveModel(point,position.scale,position.monitors,viewport.modelRect);
      if(space!==undefined)viewport.setScreenSpace(space);
    },
  );
  const viewport = new ModelViewportBridge(host,anchor,
    value=>geometryTask(async()=>{
      // Ordinary scale changes stay inside the fixed surface. If an external
      // preference expands that range, compensate an already-open menu once.
      const menu=quickMenu?.isOpen?quickMenu:undefined,generation=menuOpenGeneration;
      const rect=menu?.element.getBoundingClientRect();
      const before=menu?await window.outerPosition():undefined;
      await invoke("set_model_viewport",{viewport:value});
      if(menu&&rect&&before){
        const after=await window.outerPosition();
        if(menu.isOpen&&generation===menuOpenGeneration){
          menu.element.style.left=`${rect.left+(before.x-after.x)/(devicePixelRatio||1)}px`;
          menu.element.style.top=`${rect.top+(before.y-after.y)/(devicePixelRatio||1)}px`;
        }
      }
    }),
    ()=>{resetHostMotion=true;hostPosition.invalidate();interaction.invalidateForViewport();samplingOverlay.clear();regionPending=null;menuRegionPending=null;},
    ()=>{visitorToolbar?.place(viewport.modelRect);updateRegion();updateMenuRegion();void hostPosition.sync().catch(()=>{});},
    ()=>{void window.hide();void invoke("open_settings");},
    bubble,updateRegion,
  );
  const syncBubbleAnchor = () => viewport.setBubbleAnchor(controller?.getBubbleAnchor?.());
  // The runtime emits this after resize/reprojection. Read the current mounted
  // controller rather than retaining a callback into a replaced model.
  host.addEventListener("model-viewport-change",syncBubbleAnchor);
  await listen<{x: number; y: number}>("pet-cursor", ({payload}) => {
    controller?.setPointerPosition(payload.x, payload.y);
    visitorToolbar?.pointer(payload.x,payload.y,viewport.modelRect);
  });
  const stopMovement = await window.onMoved(() => {
    void hostPosition.sync().catch(()=>{});
  });
  const syncWindowGeometry = () => {
    if (closing) return;
    samplingOverlay.clear();
    if (modelAvailable()) interaction.resizeFixedViewport(innerWidth,innerHeight);
    syncBubbleAnchor();
    updateRegion();
    updateMenuRegion();
    void hostPosition.sync().catch(()=>{});
  };
  globalThis.addEventListener("resize",syncWindowGeometry);

  empty.addEventListener("click", () => {
    void invoke("open_settings");
  });

  const syncRendering = () => {
    const paused = !connected || !modelAvailable() || !ui.visible || pausedByTray || document.visibilityState !== "visible";
    if(paused&&presenter?.owner)void presenter.release("unavailable");
    animator?.setPaused(paused);
    if (paused) controller?.pause();
    else controller?.resume();
    samplingOverlay.setEnabled(!paused&&!closing&&settings.preferences.performanceOverlay&&settings.preferences.environmentLightingEnabled!==false&&(settings.preferences.environmentLightingStrength??1)>0);
    environmentLighting.configure(controller,settings.preferences.environmentLightingEnabled!==false,settings.preferences.environmentLightingStrength??1,!paused&&connected&&!closing);
    if(document.visibilityState!=="visible")quickMenu?.close();
    syncVisitorToolbar();
    syncInputAvailable();syncControlReport();updateRegion();updateMenuRegion();
  };
  const syncVisitorToolbar=()=>{
    const p=settings.preferences;
    const enabled=!closing&&connected&&modelAvailable()&&Boolean(controller)&&ui.visible&&!ui.clickThrough&&document.visibilityState==="visible"&&!quickMenu?.isOpen;
    const scale=temporaryScale??p.scale;
    visitorToolbar?.toolbar.update({scale,minScale:Math.min(.5,scale),maxScale:Math.max(1.5,scale),bubbles:p.bubblesVisible!==false,bubblesAllowed:true,enabled,controlActive:Boolean(presenter?.owner)});
    // The optional Bot button changes toolbar width, not its fixed foot anchor.
    visitorToolbar?.place(viewport.modelRect);
    visitorToolbar?.configure(enabled);
  };
  const controlAvailable=()=>Boolean(connected&&!closing&&controller&&modelRevision&&modelAvailable()&&ui.visible&&!ui.paused&&!pausedByTray&&!ui.clickThrough&&document.visibilityState==="visible"&&!presenter?.restoring);
  let controlReportPending=false,controlReportSending=false,lastControlReport="";
  const syncControlReport=()=>{
    controlReportPending=true;if(controlReportSending)return;
    controlReportSending=true;
    void (async()=>{
      try{while(controlReportPending&&connected&&connection){
        controlReportPending=false;
        const model=selectedModel(settings),p=settings.preferences;
        const report:ControlDesktopReport={controlVersion:1,enabled:p.sessionControlEnabled===true,available:controlAvailable(),
          ...(controller&&model&&modelRevision?{model:{revision:modelRevision,title:model.title.slice(0,120),animations:controller.getAnimations().slice(0,256).map(clip=>({name:clip.name,durationMs:clip.durationMs}))}}:{}),
          preferences:{bubblesVisible:p.bubblesVisible!==false&&!p.privacyMode,pointerEnabled:temporaryPointer??p.pointerEnabled!==false,scale:temporaryScale??p.scale}};
        const fingerprint=JSON.stringify(report);if(fingerprint===lastControlReport)continue;
        await connection.reportControl(report);lastControlReport=fingerprint;
      }}catch{lastControlReport="";}finally{controlReportSending=false;}
    })();
  };
  const restoreAutomatic=()=>{
    if(closing||!connected||presenter?.busy||!controller)return;
    if(latestSnapshot){animator?.apply(latestSnapshot);if(modelAvailable())workBubble.update(latestSnapshot,settings.preferences);}
  };
  const applyDisplayScale=async(scale:number,signal?:AbortSignal)=>{
    await viewport.configure(modelAvailable(),scale);
    if(signal?.aborted||closing)return;
    controller?.setDisplaySize?.(320*scale,480*scale);syncBubbleAnchor();controller?.refreshInteractionMask?.();
  };
  presenter=new SessionPresenter({
    available:()=>settings.preferences.sessionControlEnabled===true&&controlAvailable(),
    textAllowed:()=>settings.preferences.bubblesVisible!==false&&!settings.preferences.privacyMode,
    animations:()=>controller?.getAnimations()??[],
    enter:async signal=>{
      cancelClick();fees.cancel();workBubble.clear();animator?.disconnected();
      await geometryTask(()=>signal.aborted?Promise.resolve():invoke("begin_session_stage",{modelRect:viewport.modelRect}));
    },
    leave:async restore=>{
      temporaryScale=undefined;temporaryPointer=undefined;
      controller?.setPointerEnabled?.(settings.preferences.pointerEnabled!==false);
      await applyDisplayScale(settings.preferences.scale);
      await geometryTask(()=>invoke("end_session_stage",{modelRect:viewport.modelRect,restore}));
      resetHostMotion=true;await hostPosition.sync().catch(()=>{});
    },
    idle:()=>{const idle=selectedModel(settings)?.mappings.idle;if(controller&&idle)void controller.playAnimation(idle,{mode:"loop",restart:false}).catch(()=>{});},
    play:name=>controller!.playAnimation(name,{mode:"once",restart:true}),
    stop:()=>controller?.stopAnimation(),
    bubble:text=>{if(text)renderPlainBubble(bubble,text,"session");else{bubble.hidden=true;bubble.replaceChildren();}updateRegion();},
    stage:async(value,signal)=>{
      if(signal.aborted)return;
      if(value.pointerEnabled!==undefined){temporaryPointer=value.pointerEnabled;controller?.setPointerEnabled?.(value.pointerEnabled);}
      if(value.scale!==undefined){temporaryScale=value.scale;await applyDisplayScale(value.scale,signal);}
      if(signal.aborted)return;
      if(value.position)await geometryTask(()=>signal.aborted?Promise.resolve():invoke("set_session_stage_position",{modelRect:portraitWithToolbar(viewport.modelRect,visitorToolbar?.rect),...value.position}));
      if(signal.aborted)return;
      resetHostMotion=true;await hostPosition.sync().catch(()=>{});syncVisitorToolbar();syncControlReport();
    },
    changed:()=>{quickMenu?.refresh();restoreAutomatic();syncRendering();},
    ack:async value=>{await connection?.acknowledgeControl(value);},
    release:async value=>{await connection?.releaseControl(value);},
  });
  // A fast initial connection can show the hidden window before later native
  // subscriptions resolve. Observe that first visibility change before mount.
  document.addEventListener("visibilitychange", syncRendering);

  const beginOfflineCountdown = () => {
    connected = false;
    lastControlReport="";presenter?.disconnect();
    environmentLighting.configure(controller,false,settings.preferences.environmentLightingStrength??1,false);
    quickMenu?.close();
    fees.cancel();
    cancelClick();workBubble.clear();
    animator?.disconnected();
    syncRendering();
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
    modelRevision=undefined;syncControlReport();
    await presenter?.release("model-changed");
    if(generation!==mountGeneration||closing)return;
    hostPosition.invalidate();
    const next = settings;
    const model = selectedModel(next);
    const enabled = model?.backend === "vrm";
    fees.cancel(); cancelClick(); workBubble.clear(); bubble.hidden = true;
    visitorToolbar?.configure(false);
    animator?.disconnected(); animator = undefined;
    environmentLighting.configure(undefined,false,next.preferences.environmentLightingStrength??1,false);
    slot.destroy(); controller = undefined;
    syncBubbleAnchor();
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
      modelRevision=crypto.randomUUID();
      mounted.setPerformanceVisible?.(settings.preferences.performanceOverlay);
      mounted.setPointerEnabled?.(settings.preferences.pointerEnabled!==false);
      mounted.setModelAdjustments?.(selectedModel(settings)?.adjustments ?? {});
      mounted.setBubblesVisible?.(false);
      syncBubbleAnchor();
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
      empty.textContent = t("模型运行时加载失败，请打开设置检查模型。");
    }
  };
  const menuResize=new ResizeObserver(updateMenuRegion);
  const menuMutation=new MutationObserver(updateMenuRegion);
  const syncMenuSurface=()=>{
    const open=quickMenu?.isOpen===true;
    if(!open)++menuOpenGeneration;
    syncVisitorToolbar();
    updateMenuRegion();
  };
  const closeQuickMenu=()=>{++menuOpenGeneration;quickMenu?.close();visitorToolbar?.clear();cancelClick();syncMenuSurface();};
  globalThis.addEventListener("blur",closeQuickMenu);
  globalThis.addEventListener("pagehide", () => { closing=true;presenter?.disconnect(); environmentLighting.destroy(); samplingOverlay.destroy(); if(offlineTimer)clearTimeout(offlineTimer); connectLive=undefined; earlyUrls.clear(); removeDeepLinks?.(); ++mountGeneration; document.removeEventListener("visibilitychange",syncRendering); globalThis.removeEventListener("resize",syncWindowGeometry);globalThis.removeEventListener("blur",closeQuickMenu);host.removeEventListener("model-viewport-change",syncBubbleAnchor); hostPosition.invalidate(); stopMovement(); cancelClick(); fees.cancel(); bubbleObserver.disconnect(); menuResize.disconnect();menuMutation.disconnect();quickMenu?.destroy();visitorToolbar?.destroy();void geometryInvoke("set_menu_interaction_region",{region:null});workBubble.clear(); connection?.stop(); animator?.disconnected(); slot.destroy(); interaction.update(undefined); void viewport.destroy(); }, {once:true});
  let settingsRevision = 0;
  let preparing = true;
  await listen<{modelId: string; adjustments: ModelAdjustments}>("model-adjustments-preview", async ({payload}) => {
    if (payload?.modelId !== settings.activeModelId || !controller) return;
    if(presenter?.busy)await presenter.release();
    if(payload.modelId!==settings.activeModelId||!controller)return;
    // The VRM controller validates values before changing its live state.
    try { controller.setModelAdjustments?.(payload.adjustments); } catch { /* Reject an invalid transient editor event. */ }
  });
  await listen<DesktopSettings>("settings-changed", async ({ payload }) => {
    const revision=++settingsRevision;
    const previous=settings;
    settings = payload;
    if(presenter?.busy)await presenter.release("user");
    if(revision!==settingsRevision||closing)return;
    quickMenu?.refresh();
    fees.cancel();
    if (latestSnapshot && modelAvailable()) workBubble.update(latestSnapshot, settings.preferences);
    else workBubble.clear();
    syncInputAvailable();
    if (preparing) return;
    if (renderingIdentity(previous) === renderingIdentity(settings)) {
      controller?.setFrameRate?.(settings.preferences.fps);
      controller?.setPointerEnabled?.(settings.preferences.pointerEnabled!==false);
      if (JSON.stringify(selectedModel(previous)?.adjustments) !== JSON.stringify(selectedModel(settings)?.adjustments)) {
        controller?.setModelAdjustments?.(selectedModel(settings)?.adjustments ?? {});
      }
      if(previous.preferences.scale!==settings.preferences.scale){
        const scale=settings.preferences.scale;
        void viewport.configure(modelAvailable(),scale).then(()=>{
          if(settings.preferences.scale!==scale)return;
          controller?.setDisplaySize?.(320*scale,480*scale);
          syncBubbleAnchor();
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
      }
      syncRendering();
      return;
    }
    void remount()
      .then(() => {
        if (connected && ui.visible && modelAvailable() && controller) void window.show();
      })
      .catch(() => {
        empty.hidden = false;
        empty.textContent = t("模型运行时加载失败，请打开设置检查模型。");
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
    onControl:frame=>presenter?.receive(frame),
    onSnapshot(snapshot) {
      if(snapshot.session?.ref!==latestSnapshot?.session?.ref || snapshot.inputRequest!==latestSnapshot?.inputRequest){fees.cancel();cancelClick();}
      latestSnapshot = snapshot;
      if(presenter?.busy)return;
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
      syncRendering();
    },
    onDisconnected() {
      beginOfflineCountdown();
    },
    onConflict() {
      void message(t("桌宠已连接另一个 DSH Host，当前不会切换。\n\n已保留第一个等待连接的 Host。原 Host 正常退出后会立即接管；异常断线则保留 60 秒重连期。原 Host 恢复时继续使用原连接。停滞连接最多需要 45 秒检测。后续启动不会覆盖等待中的 Host。"), {title:t("StarLite for DSH · 等待连接"),kind:"info"}).catch(()=>{});
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
    if(payload==="pause"||payload==="resume"||payload==="reset")void presenter?.release();
    if (payload === "pause") pausedByTray = true;
    if (payload === "resume") pausedByTray = false;
    if (payload === "pause" || payload === "resume") syncRendering();
    if (payload === "reset") controller?.resetCamera();
  });
  await listen<PetUiState>("pet-ui-state",({payload})=>{
    if(payload.paused!==ui.paused||payload.visible!==ui.visible||payload.clickThrough!==ui.clickThrough)void presenter?.release();
    ui=payload;pausedByTray=payload.paused;
    quickMenu?.refresh();
    if(!payload.visible||payload.clickThrough)quickMenu?.close();
    syncRendering();
  });
  ui=await invoke<PetUiState>("get_pet_ui_state");pausedByTray=ui.paused;syncRendering();
  quickMenu=await createPetQuickMenu(createQuickMenu,{
    readSettings:()=>settings,readUi:()=>ui,
    controlOwner:()=>presenter?.owner?settings.preferences.privacyMode?"DSH":presenter.owner.title:undefined,releaseControl:async()=>{await presenter?.release();},
    patch:async patch=>{await presenter?.release();await invoke("patch_preferences",{patch});},
    pause:async paused=>{await presenter?.release();await invoke("set_pet_paused",{paused});},
    hide:async()=>{await presenter?.release();await invoke("set_pet_visible",{visible:false});},
    restorePosition:async()=>{await presenter?.release("user",false);await geometryTask(()=>invoke("restore_default_position",{modelRect:portraitWithToolbar(viewport.modelRect,visitorToolbar?.rect)}));void hostPosition.sync().catch(()=>{});},
    openSettings:async()=>{await presenter?.release();await invoke("open_settings");},
    openDsh:async()=>{if(connection&&connected)await openDisplayedDsh(connection,latestSnapshot?.session?.ref,presenter?.owner?.leaseId);},
    selectModel:async modelId=>{await presenter?.release("model-changed");await invoke("select_model",{modelId});},
  });
  quickMenu.element.addEventListener("starlite-menu-change",syncMenuSurface);
  menuResize.observe(quickMenu.element);
  menuMutation.observe(quickMenu.element,{attributes:true,childList:true,subtree:true});
  visitorToolbar=new PetVisitorToolbar(await createVisitorToolbar({
    locale:uiLocale(),
    onSmaller:async()=>{await presenter?.release();await invoke("patch_preferences",{patch:{scale:steppedPetScale(settings.preferences.scale,-1)}});},
    onLarger:async()=>{await presenter?.release();await invoke("patch_preferences",{patch:{scale:steppedPetScale(settings.preferences.scale,1)}});},
    onBubbles:async()=>{await presenter?.release();await invoke("patch_preferences",{patch:{bubblesVisible:settings.preferences.bubblesVisible===false}});},
    onHide:async()=>{await presenter?.release();visitorToolbar?.clear();await invoke("set_pet_visible",{visible:false});},
    onReleaseControl:async()=>{await presenter?.release();},
  }),viewport.modelRect,updateMenuRegion);
  syncVisitorToolbar();
  cancelClick=installPointerBehavior(host, {
    begin: async (x, y) => {
      // Authorize the visible silhouette before restoring a session's scale.
      // Native viewport rebasing preserves this drag's physical displacement;
      // restoring first can move an enlarged head away from the pressed point.
      await invoke("begin_model_drag",{x,y});
      await presenter?.release("user",false);
    },
    move: () => invoke("move_model_drag"),
    end: async () => {
      try{return await invoke("end_model_drag");}
      finally{void hostPosition.sync().catch(()=>{});}
    },
  }, () => {if(presenter?.busy)return;void fees.show(); void animator?.click();}, (x, y) => interaction.hitTest(x, y), await loadModelDragGesture(), (x,y) => {
    visitorToolbar?.clear();
    const generation=++menuOpenGeneration;
    void viewport.ready().then(async()=>{
      // Native set_size acknowledges before WebView layout necessarily catches
      // up. Complete that layout before the one-time placement measurement.
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const position=await readPosition();
      if(closing||generation!==menuOpenGeneration)return;
      quickMenu?.open(x,y);
      // Finish placement in the same task as open, before the first paint.
      fitQuickMenu({x,y},position);
      controller?.refreshInteractionMask?.();updateMenuRegion();
    }).catch(()=>{});
  },()=>{
    const ref=latestSnapshot?.session?.ref;
    const lease=presenter?.owner?.leaseId;
    if(!connected||!connection)return;
    void openDisplayedDsh(connection,ref,lease).catch(()=>{
      // Preserve the session's authored bubble while it owns presentation.
      if(!presenter?.busy&&settings.preferences.bubblesVisible!==false&&latestSnapshot?.session?.ref===ref&&!latestSnapshot?.inputRequest){renderPlainBubble(bubble,ref?t("暂时无法打开 DSH 会话"):t("暂时无法打开 DSH"),"notice",settings.preferences.privacyMode?"DSH":latestSnapshot?.session?.title);updateRegion();}
    });
  });
  await keepWindowVisible(window);
}

export function openDisplayedDsh(connection: Pick<StatusConnection,"openSession"|"openWebUi"> & Partial<Pick<StatusConnection,"openControlSession">>, sessionRef?: string,leaseId?:string): Promise<void> {
  if(leaseId)return connection.openControlSession?connection.openControlSession(leaseId):connection.openWebUi();
  return sessionRef ? connection.openSession(sessionRef) : connection.openWebUi();
}

export function installPointerBehavior(
  element: HTMLElement,
  drag: {begin: (x: number, y: number) => Promise<unknown>; move: () => Promise<unknown>; end: () => Promise<unknown>},
  click: () => void | Promise<void>,
  hitTest: (x: number, y: number) => boolean,
  isModelDrag: (dx:number,dy:number) => boolean,
  openSettings?: (x:number,y:number) => void,
  doubleClick?: () => void | Promise<void>,
): () => void {
  type Gesture={id:number;x:number;y:number;clientX:number;clientY:number;moved:boolean;started:boolean;cancelled:boolean;queued:boolean;chain:Promise<unknown>};
  let gesture: Gesture | undefined;
  let dragTail:Promise<unknown>=Promise.resolve();
  let clickEpoch=0;
  let clickTimer:ReturnType<typeof setTimeout>|undefined;
  let firstClick:{x:number;y:number;ready:Promise<unknown>}|undefined;
  const clearClick=()=>{if(clickTimer)clearTimeout(clickTimer);clickTimer=undefined;firstClick=undefined;};
  const cancelClick=()=>{++clickEpoch;clearClick();};
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
  const begin=(current:Gesture)=>{
    if(current.started)return;
    current.started=true;
    current.chain=current.chain.then(()=>{if(!current.cancelled)return drag.begin(current.clientX,current.clientY);});
    void current.chain.catch(()=>{});
  };
  const finish = (event: PointerEvent, cancelled: boolean) => {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    gesture = undefined;
    current.cancelled=cancelled;
    if(!cancelled)current.moved ||= isModelDrag(event.screenX-current.x,event.screenY-current.y);
    if (element.hasPointerCapture(current.id)) element.releasePointerCapture(current.id);
    if(current.moved||cancelled)cancelClick();else completeClick(event,current.chain);
    if(current.moved&&!cancelled)begin(current);
    if(current.started)dragTail = current.chain.then(async () => {
      if (!cancelled) await drag.move();
    }).finally(() => drag.end()).catch(() => {});
  };
  const cancel=()=>{
    cancelClick();
    if(gesture)finish({pointerId:gesture.id} as PointerEvent,true);
  };
  element.addEventListener("pointerdown", (event) => {
    if (gesture || event.button !== 0 || !hitTest(event.clientX, event.clientY)) return;
    gesture = {id:event.pointerId,x:event.screenX,y:event.screenY,clientX:event.clientX,clientY:event.clientY,moved:false,started:false,cancelled:false,queued:false,chain:dragTail};
    try{element.setPointerCapture(event.pointerId);}catch{cancel();}
  });
  element.addEventListener("pointermove", (event) => {
    const current=gesture;
    if (!current || event.pointerId !== current.id || current.queued) return;
    if (!current.moved && !isModelDrag(event.screenX-current.x,event.screenY-current.y)) return;
    current.moved=true;current.queued=true;
    cancelClick();begin(current);
    current.chain=current.chain.then(()=>{if(!current.cancelled)return drag.move();}).finally(()=>{current.queued=false});
    void current.chain.catch(() => {});
  });
  element.addEventListener("pointerup", event=>finish(event,false));
  element.addEventListener("pointercancel", event=>finish(event,true));
  element.addEventListener("lostpointercapture", event=>finish(event,true));
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

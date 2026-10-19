import type {DesktopPreferences, DesktopSettings} from "./types.js";
import type {QuickMenu, QuickMenuOptions, QuickSettingItem} from "./vendor-types.js";

export interface PetUiState {paused:boolean;visible:boolean;clickThrough:boolean}
export interface PetQuickSettingsActions {
  readSettings():DesktopSettings;
  readUi():PetUiState;
  patch(value:Partial<DesktopPreferences>):Promise<void>;
  pause(value:boolean):Promise<void>;
  hide():Promise<void>;
  restorePosition():Promise<void>;
  openSettings():Promise<void>;
  openDsh():Promise<void>;
  selectModel(id:string):Promise<void>;
}

/** Hosts own state; the shared menu only renders controls and calls actions. */
export function petQuickSettings(actions:PetQuickSettingsActions,close:()=>void):QuickMenuOptions {
  const settings=actions.readSettings(),p=settings.preferences,ui=actions.readUi();
  const run=(operation:()=>Promise<void>)=>async()=>{await operation();close();};
  const display:QuickSettingItem[]=[
    {id:"size",kind:"range",label:"模型大小",value:p.scale,min:Math.min(.5,p.scale),max:Math.max(1.5,p.scale),step:.05,formatValue:value=>`${Math.round(value*100)}%`,onChange:scale=>actions.patch({scale})},
    {id:"reset-size",kind:"action",label:"恢复默认大小",onAction:()=>actions.patch({scale:1})},
    {id:"position",kind:"action",label:"恢复默认位置",onAction:run(actions.restorePosition)},
    {id:"fps",kind:"select",label:"帧率",value:String(p.fps),options:[{value:"30",label:"30 FPS"},{value:"60",label:"60 FPS"}],onChange:value=>actions.patch({fps:value==="30"?30:60})},
    {id:"performance",kind:"toggle",label:"显示性能参数",value:p.performanceOverlay,onChange:performanceOverlay=>actions.patch({performanceOverlay})},
  ];
  if(settings.models.length>1)display.unshift({id:"model",kind:"select",label:"当前模型",value:settings.activeModelId??"",options:settings.models.filter(model=>model.backend==="vrm").map(model=>({value:model.id,label:model.title})),onChange:actions.selectModel});
  return {title:"StarLite",tabs:[
    {id:"display",label:"显示",items:display},
    {id:"interaction",label:"互动",items:[
      {id:"pointer",kind:"toggle",label:"光标跟随",value:p.pointerEnabled!==false,onChange:pointerEnabled=>actions.patch({pointerEnabled})},
      {id:"bubbles",kind:"toggle",label:"显示气泡",value:p.bubblesVisible!==false,description:"关闭后保留动画；输入题请在 DSH 中回答。",onChange:bubblesVisible=>actions.patch({bubblesVisible})},
      {id:"pause",kind:"toggle",label:"暂停动画",value:ui.paused,onChange:actions.pause},
      {id:"hide",kind:"action",label:"暂时隐藏",description:"从 StarLite 托盘菜单恢复。",onAction:run(actions.hide)},
    ]},
    {id:"work",label:"DSH",items:[
      {id:"bubble-mode",kind:"select",label:"工作气泡",value:p.bubbleMode,disabled:p.bubblesVisible===false,options:[{value:"compact",label:"精简"},{value:"detailed",label:"详细"}],onChange:value=>actions.patch({bubbleMode:value==="detailed"?"detailed":"compact"})},
      {id:"privacy",kind:"toggle",label:"隐藏会话内容",value:p.privacyMode,onChange:privacyMode=>actions.patch({privacyMode})},
      {id:"open-dsh",kind:"action",label:"打开当前会话 / DSH",onAction:run(actions.openDsh)},
      {id:"settings",kind:"action",label:"更多设置 · 模型与许可",onAction:run(actions.openSettings)},
    ]},
  ]};
}

export interface PetQuickMenu extends QuickMenu {refresh():void}
export async function createPetQuickMenu(factory:(options:QuickMenuOptions)=>Promise<QuickMenu>,actions:PetQuickSettingsActions):Promise<PetQuickMenu> {
  let menu:QuickMenu;
  const options=()=>petQuickSettings(actions,()=>menu.close());
  menu=await factory(options());
  return {
    element:menu.element,
    get isOpen(){return menu.isOpen;},
    open(x,y){menu.update(options());menu.open(x,y);},
    close:()=>menu.close(),
    refresh:()=>menu.update(options()),
    update:()=>menu.update(options()),
    destroy:()=>menu.destroy(),
  };
}

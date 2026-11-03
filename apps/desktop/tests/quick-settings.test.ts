import {expect,it,vi} from "vitest";
import {petQuickSettings,type PetQuickSettingsActions} from "../src/quick-settings.js";
import type {DesktopSettings} from "../src/types.js";

const settings:DesktopSettings={schemaVersion:4,preferences:{fps:60,scale:.67,maxDevicePixelRatio:1,privacyMode:false,bubbleMode:"compact",performanceOverlay:false},activeModelId:null,models:[]};
function fixture(next=settings){
  const actions:PetQuickSettingsActions={readSettings:()=>next,readUi:()=>({paused:false,visible:true,clickThrough:false}),patch:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),hide:vi.fn(async()=>{}),restorePosition:vi.fn(async()=>{}),openSettings:vi.fn(async()=>{}),openDsh:vi.fn(async()=>{}),selectModel:vi.fn(async()=>{})};
  const close=vi.fn();return{actions,close,menu:petQuickSettings(actions,close)};
}

it("offers only approved quick controls and keeps application actions outside interaction toggles",()=>{
  const f=fixture(),items=f.menu.tabs.flatMap(tab=>tab.items);
  expect(f.menu.tabs.map(tab=>tab.label)).toEqual(["显示","互动","DSH"]);
  expect(items.map(item=>item.id)).toEqual(["size","reset-size","position","fps","performance","environment-lighting","environment-strength","pointer","bubbles","pause","hide","bubble-mode","privacy","open-dsh","settings"]);
  expect(items.some(item=>/偶发|点击回应|查看费用/u.test(item.label))).toBe(false);
});
it("defaults environment lighting on and preserves an explicit disabled preference",async()=>{
  const f=fixture(),items=f.menu.tabs[0]!.items;
  const toggle=items.find(item=>item.id==="environment-lighting")!,strength=items.find(item=>item.id==="environment-strength")!;
  if(toggle.kind!=="toggle"||strength.kind!=="range")throw Error("expected lighting controls");
  expect(toggle.value).toBe(true);expect(toggle.description).toContain("不保存或上传");
  expect(strength.value).toBe(1);expect(strength.disabled).toBe(false);
  expect(strength.min).toBe(0);expect(strength.max).toBe(2);
  await toggle.onChange(false);
  expect(f.actions.patch).toHaveBeenCalledExactlyOnceWith({environmentLightingEnabled:false});
  const disabled=fixture({...settings,preferences:{...settings.preferences,environmentLightingEnabled:false}});
  const disabledToggle=disabled.menu.tabs[0]!.items.find(item=>item.id==="environment-lighting")!;
  expect(disabledToggle.kind==="toggle"&&disabledToggle.value).toBe(false);
  expect(disabled.menu.tabs[0]!.items.find(item=>item.id==="environment-strength")!.disabled).toBe(true);
  const saved=fixture({...settings,preferences:{...settings.preferences,environmentLightingEnabled:true,environmentLightingStrength:.35}});
  const enabled=saved.menu.tabs[0]!.items.find(item=>item.id==="environment-strength")!;
  if(enabled.kind!=="range")throw Error("expected strength range");
  expect(enabled.disabled).toBe(false);expect(enabled.value).toBe(.35);
  expect(enabled.formatValue?.(.35)).toBe("35%");
  expect(enabled.formatValue?.(2)).toBe("200%");
  await enabled.onChange(2);
  expect(saved.actions.patch).toHaveBeenCalledExactlyOnceWith({environmentLightingStrength:2});
});
it("disables all bubbles with a field patch, leaving action mappings and animation pause alone",async()=>{
  const f=fixture(),item=f.menu.tabs[1]!.items.find(item=>item.id==="bubbles")!;
  if(item.kind!=="toggle")throw Error("expected toggle");
  await item.onChange(false);
  expect(f.actions.patch).toHaveBeenCalledExactlyOnceWith({bubblesVisible:false});
  expect(f.actions.pause).not.toHaveBeenCalled();expect(f.actions.selectModel).not.toHaveBeenCalled();
  const hidden=fixture({...settings,preferences:{...settings.preferences,bubblesVisible:false}});
  expect(hidden.menu.tabs[2]!.items[0]!.disabled).toBe(true);
});
it("restores the model position and closes only after the native operation succeeds",async()=>{
  const f=fixture(),item=f.menu.tabs[0]!.items.find(item=>item.id==="position")!;
  if(item.kind!=="action")throw Error("expected action");
  await item.onAction();expect(f.actions.restorePosition).toHaveBeenCalledOnce();expect(f.close).toHaveBeenCalledOnce();
});

// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from "vitest";
import {PetVisitorToolbar,portraitWithToolbar,steppedPetScale} from "../src/visitor-toolbar.js";
import type {VisitorToolbar} from "../src/vendor-types.js";

afterEach(()=>vi.useRealTimers());
const portrait={left:128,top:532,width:214,height:322};
function fixture(){
  const toolbar:VisitorToolbar={element:document.createElement("aside"),dimensions:{width:152,height:42},show:vi.fn(),place:vi.fn(),update:vi.fn(),reattach:vi.fn(),destroy:vi.fn()};
  const changed=vi.fn(),bridge=new PetVisitorToolbar(toolbar,portrait,changed);
  bridge.configure(true);return{toolbar,changed,bridge};
}
it("appears only near the logical portrait or controls and leaves after a short delay",async()=>{
  vi.useFakeTimers();const {toolbar,bridge,changed}=fixture();
  expect(bridge.visible).toBe(false);bridge.pointer(0,0,portrait);expect(changed).not.toHaveBeenCalled();
  bridge.pointer(150,600,portrait);expect(bridge.visible).toBe(true);
  bridge.pointer(200,875,portrait);await vi.advanceTimersByTimeAsync(1000);expect(bridge.visible).toBe(true);
  bridge.pointer(0,0,portrait);await vi.advanceTimersByTimeAsync(649);expect(bridge.visible).toBe(true);
  await vi.advanceTimersByTimeAsync(1);expect(bridge.visible).toBe(false);expect(toolbar.show).toHaveBeenLastCalledWith(false);
  bridge.destroy();expect(toolbar.destroy).toHaveBeenCalledOnce();
});
it("holds keyboard focus, clears on hide or blur, and does not reopen from stationary native cursor polling",async()=>{
  vi.useFakeTimers();const {toolbar,bridge}=fixture();bridge.pointer(150,600,portrait);
  toolbar.element.dispatchEvent(new CustomEvent("starlite-toolbar-focus",{detail:{focused:true}}));
  bridge.pointer(0,0,portrait);await vi.advanceTimersByTimeAsync(1000);expect(bridge.visible).toBe(true);
  toolbar.element.dispatchEvent(new CustomEvent("starlite-toolbar-focus",{detail:{focused:false}}));
  await vi.advanceTimersByTimeAsync(650);expect(bridge.visible).toBe(false);
  bridge.pointer(150,600,portrait);bridge.clear();bridge.pointer(150,600,portrait);expect(bridge.visible).toBe(false);
  bridge.pointer(151,600,portrait);expect(bridge.visible).toBe(true);
  bridge.configure(false);bridge.pointer(152,600,portrait);expect(bridge.visible).toBe(false);bridge.destroy();
});
it("keeps controls fixed in CSS pixels when the displayed portrait changes size",()=>{
  const {toolbar,bridge}=fixture();const rect=bridge.rect;
  for(const scale of [.5,.6,1,1.5]){
    bridge.pointer(140,550,{...portrait,width:320*scale,height:480*scale});bridge.place();
    expect(bridge.rect).toEqual(rect);
    expect(toolbar.place).toHaveBeenLastCalledWith(235,864,1000);
  }
  expect(rect).toEqual({left:159,top:864,width:152,height:42});bridge.destroy();
});
it("re-centers the optional control button width without revealing a hidden toolbar or shifting its foot anchor",()=>{
  const {toolbar,bridge,changed}=fixture();
  let controlActive=false;
  Object.defineProperty(toolbar,"dimensions",{get:()=>({width:controlActive?188:152,height:42})});
  for(const active of [true,false]){
    controlActive=active;bridge.place(portrait);
    expect(bridge.visible).toBe(false);expect(changed).not.toHaveBeenCalled();
    expect(toolbar.place).toHaveBeenLastCalledWith(235,864,1000);
    expect(bridge.rect.width).toBe(active?188:152);
    expect(bridge.rect.left+bridge.rect.width/2).toBe(235);
  }
  bridge.pointer(150,600,portrait);expect(bridge.visible).toBe(true);
  controlActive=true;bridge.place(portrait);expect(bridge.visible).toBe(true);expect(changed).toHaveBeenCalledOnce();
  bridge.destroy();
});
it("releases real button focus when native blur clears the visible toolbar region",()=>{
  const {toolbar,bridge,changed}=fixture(),button=document.createElement("button");
  toolbar.element.append(button);document.body.append(toolbar.element);
  bridge.pointer(150,600,portrait);button.focus();
  toolbar.element.dispatchEvent(new CustomEvent("starlite-toolbar-focus",{detail:{focused:true}}));
  expect(document.activeElement).toBe(button);
  bridge.clear();expect(bridge.visible).toBe(false);expect(toolbar.element.contains(document.activeElement)).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);bridge.destroy();toolbar.element.remove();
});
it("steps the existing preference by ten percentage points and respects its menu limits",()=>{
  expect(steppedPetScale(.67,-1)).toBe(.57);expect(steppedPetScale(.67,1)).toBe(.77);
  expect(steppedPetScale(.5,-1)).toBe(.5);expect(steppedPetScale(1.5,1)).toBe(1.5);
  expect(steppedPetScale(.55,-1)).toBe(.5);expect(steppedPetScale(1.45,1)).toBe(1.5);
  expect(steppedPetScale(.25,-1)).toBe(.25);expect(steppedPetScale(3,1)).toBe(3);
});
it("restores both a shrunk portrait and its fixed toolbar inside the screen work area",()=>{
  const small={left:128,top:532,width:160,height:240};
  const fixed={left:292,top:1262,width:152,height:42};
  expect(portraitWithToolbar(small,fixed)).toEqual({left:128,top:532,width:316,height:772});
  expect(portraitWithToolbar(small)).toBe(small);
});

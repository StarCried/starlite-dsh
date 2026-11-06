// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {EnvironmentSamplingOverlay} from "../src/environment-debug.js";
import type {EnvironmentPatch} from "../src/environment-lighting.js";

const sample={color:"#204a9e",viewportWidth:800,viewportHeight:600,patches:[{left:300,top:250,width:12,height:12},{left:420,top:250,width:12,height:12}]};
const intersects=(a:EnvironmentPatch,b:EnvironmentPatch)=>a.left<b.left+b.width&&a.left+a.width>b.left&&a.top<b.top+b.height&&a.top+a.height>b.top;
let now=0;
beforeEach(()=>{document.body.replaceChildren();vi.stubGlobal("innerWidth",800);vi.stubGlobal("innerHeight",600);now=0;vi.spyOn(performance,"now").mockImplementation(()=>now);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it("shows only the accepted native patches while enabled and clears them on disable/destroy",()=>{
  const overlay=new EnvironmentSamplingOverlay("Environment lighting sample regions");
  overlay.update(sample);expect(document.querySelector("[data-environment-samples]")).toBeNull();
  overlay.setEnabled(true);overlay.update(sample);
  expect(document.querySelectorAll("[data-environment-sample]")).toHaveLength(2);
  expect(document.querySelector("[data-environment-samples]")?.getAttribute("aria-label")).toBe("Environment lighting sample regions");
  overlay.setEnabled(false);overlay.update(sample);
  expect(document.querySelector("[data-environment-samples]")).toBeNull();
  overlay.setEnabled(true);overlay.update(sample);overlay.destroy();overlay.destroy();overlay.update(sample);
  expect(document.querySelector("[data-environment-samples]")).toBeNull();
});

it("excludes displayed frame strokes without excluding the empty capture centres",()=>{
  const overlay=new EnvironmentSamplingOverlay("Samples");overlay.setEnabled(true);overlay.update(sample);
  const regions=overlay.exclusions().regions;
  expect(regions).toHaveLength(8);
  for(const patch of sample.patches)expect(regions.some(r=>intersects(r,patch))).toBe(false);
  // A future candidate moving onto an old top border must be rejected.
  expect(regions.some(r=>intersects(r,{left:300,top:243,width:12,height:3}))).toBe(true);
  overlay.setEnabled(false);
  expect(overlay.exclusions().regions).toHaveLength(8);
  now=151;expect(overlay.exclusions().regions).toHaveLength(0);
});

it("excludes plain-text bubbles and fading UI with shadows, independently of click regions",()=>{
  const bubble=document.createElement("output");bubble.id="bubble";
  const toolbar=document.createElement("aside");toolbar.dataset.starliteVisitorToolbar="";toolbar.dataset.visible="false";toolbar.style.opacity="0.2";
  vi.spyOn(bubble,"getBoundingClientRect").mockReturnValue({left:200,top:100,width:180,height:80} as DOMRect);
  vi.spyOn(toolbar,"getBoundingClientRect").mockReturnValue({left:250,top:500,width:152,height:42} as DOMRect);
  document.body.append(bubble,toolbar);
  const overlay=new EnvironmentSamplingOverlay("Samples");
  let regions=overlay.exclusions().regions;
  expect(bubble.dataset.interactive).toBeUndefined();expect(regions).toHaveLength(2);
  expect(regions.some(r=>intersects(r,{left:185,top:90,width:12,height:12}))).toBe(true);
  bubble.hidden=true;toolbar.style.opacity="0";
  now=200;expect(overlay.exclusions().regions).toHaveLength(2);
  now=251;expect(overlay.exclusions().regions).toHaveLength(2);
  now=351;expect(overlay.exclusions().regions).toHaveLength(0);
  toolbar.dataset.visible="true";
  expect(overlay.exclusions().regions).toHaveLength(1);
});

it("rejects a capture if a bubble appears or moves while native work is pending",()=>{
  const overlay=new EnvironmentSamplingOverlay("Samples"),before=overlay.exclusions();
  const bubble=document.createElement("output");bubble.id="bubble";
  let left=200;
  vi.spyOn(bubble,"getBoundingClientRect").mockImplementation(()=>({left,top:100,width:180,height:80}) as DOMRect);
  document.body.append(bubble);
  expect(overlay.matches(before)).toBe(false);
  const stable=overlay.exclusions();expect(overlay.matches(stable)).toBe(true);
  left=220;expect(overlay.matches(stable)).toBe(false);
});

it("clips exclusions to the window and keeps a crowded layout fail-closed",()=>{
  const overlay=new EnvironmentSamplingOverlay("Samples");
  for(let i=0;i<41;i++){
    const ui=document.createElement("div");ui.dataset.environmentExclusion="";
    vi.spyOn(ui,"getBoundingClientRect").mockReturnValue({left:5,top:5,width:100,height:40} as DOMRect);document.body.append(ui);
  }
  expect(overlay.exclusions()).toEqual({viewportWidth:800,viewportHeight:600,regions:[{left:0,top:0,width:800,height:600}]});
});

it.each([
  null,
  {...sample,patches:[]},
  {...sample,viewportWidth:801},
  {...sample,patches:Array.from({length:9},()=>sample.patches[0]!)},
  {...sample,patches:[{left:790,top:100,width:12,height:12}]},
  {...sample,patches:[{left:NaN,top:100,width:12,height:12}]},
])("clears invalid, unavailable or stale viewport geometry",value=>{
  const overlay=new EnvironmentSamplingOverlay("Samples");overlay.setEnabled(true);overlay.update(sample);
  overlay.update(value);expect(document.querySelector("[data-environment-samples]")).toBeNull();
});

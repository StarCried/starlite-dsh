import {expect,it} from "vitest";
import {menuWorkArea} from "../src/menu-placement.js";

const monitors=[
  {position:{x:0,y:0},size:{width:2560,height:1440},workArea:{position:{x:0,y:0},size:{width:2560,height:1400}}},
  {position:{x:2560,y:0},size:{width:1920,height:1080},workArea:{position:{x:2560,y:0},size:{width:1920,height:1040}}},
];
it("uses the clicked model display when the not-yet-fitted menu center falls onto its neighbor",()=>{
  // At 125% the proposed 300px card center would be x2566, on display two.
  const bounds=menuWorkArea({x:2088,y:380},1,{width:736,height:1444},{x:328,y:220},monitors)!;
  expect(bounds).toEqual({left:8,top:8,right:464,bottom:1012});
  expect(bounds.right-bounds.left).toBeGreaterThan(300);
});
it("handles negative origins, DPI scaling and a click on the second monitor",()=>{
  const left={position:{x:-1920,y:0},size:{width:1920,height:1080},workArea:{position:{x:-1920,y:0},size:{width:1920,height:1040}}};
  expect(menuWorkArea({x:-600,y:-300},1.5,{width:736,height:1444},{x:200,y:500},[left,...monitors])).toEqual({left:8,top:208,right:392,bottom:885.3333333333334});
  const right=menuWorkArea({x:2500,y:0},1,{width:736,height:1444},{x:200,y:100},monitors)!;
  expect(right.left).toBe(68);expect(right.right).toBe(728);
});
it("uses the largest visible intersection if the original click is no longer on a display",()=>{
  expect(menuWorkArea({x:2088,y:380},1,{width:736,height:1444},{x:2000,y:2000},monitors)?.right).toBe(464);
  expect(menuWorkArea({x:8000,y:8000},1,{width:736,height:1444},{x:100,y:100},monitors)).toBeUndefined();
});

import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {EnvironmentLightingBridge, type EnvironmentColor} from "../src/environment-lighting.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const controller = () => ({setEnvironmentLighting:vi.fn()});
function pending() {
  let resolve!: (value:EnvironmentColor|null) => void;
  const promise = new Promise<EnvironmentColor|null>(done => {resolve=done;});
  return {promise,resolve};
}

it("does not sample until enabled, visible, running, and supported",async()=>{
  const read=vi.fn(async()=>({color:"#112233"})),bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,false,.2,true);
  bridge.configure(target,true,.2,false);
  bridge.configure({},true,.2,true);
  bridge.configure(target,true,0,true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).not.toHaveBeenCalled();
  bridge.configure(target,true,.2,true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledOnce();
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#112233",strength:.2});
  bridge.destroy();
});

it("polls at most four times per second with no overlapping capture or catch-up",async()=>{
  const first=pending(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({color:"#123456"});
  const bridge=new EnvironmentLightingBridge(read);
  bridge.configure(controller(),true,.2,true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledOnce();
  first.resolve({color:"#abcdef"});
  await vi.advanceTimersByTimeAsync(249);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  bridge.destroy();
});

it("rejects late samples across model replacement without starting concurrent captures",async()=>{
  const first=pending(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({color:"#222222"});
  const bridge=new EnvironmentLightingBridge(read),old=controller(),next=controller();
  bridge.configure(old,true,.2,true);
  bridge.configure(next,true,.4,true);
  expect(read).toHaveBeenCalledOnce();
  expect(old.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith(null);
  first.resolve({color:"#111111"});
  await vi.advanceTimersByTimeAsync(1);
  expect(next.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith({color:"#222222",strength:.4});
  expect(old.setEnvironmentLighting).toHaveBeenCalledOnce();
  bridge.destroy();
});

it.each(["disabled","paused"] as const)("stops on %s and does not apply a pending result",async reason=>{
  const first=pending(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({color:"#aabbcc"});
  const bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,.2,true);
  bridge.configure(target,reason!=="disabled",.2,reason!=="paused");
  first.resolve({color:"#ffffff"});
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledOnce();
  expect(target.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith(null);
  bridge.configure(target,true,.2,true);
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#aabbcc",strength:.2});
  bridge.destroy();
});

it("discards old-strength results and retains lighting across unavailable or malformed samples",async()=>{
  const first=pending(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({color:"#abcdef"}).mockRejectedValueOnce(Error("unavailable")).mockResolvedValueOnce({color:"red"}).mockResolvedValueOnce(null).mockResolvedValue({color:"#123456"});
  const bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,.2,true);
  bridge.configure(target,true,.6,true);
  first.resolve({color:"#111111"});
  await vi.advanceTimersByTimeAsync(1);
  expect(target.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith({color:"#abcdef",strength:.6});
  await vi.advanceTimersByTimeAsync(750);
  expect(target.setEnvironmentLighting).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(250);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#123456",strength:.6});
  bridge.destroy();
});

it("changes strength while retaining the last color until another valid sample arrives",async()=>{
  const next=pending(),read=vi.fn().mockResolvedValueOnce({color:"#abcdef"}).mockReturnValueOnce(next.promise).mockResolvedValue(null);
  const bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,1,true);
  await vi.advanceTimersByTimeAsync(250);
  bridge.configure(target,true,1.5,true);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#abcdef",strength:1.5});
  expect(read).toHaveBeenCalledTimes(2);
  next.resolve({color:"#ffffff"});
  await vi.advanceTimersByTimeAsync(1);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#abcdef",strength:1.5});
  bridge.destroy();
});

it.each(["disabled","paused","replaced"] as const)("does not carry retained color across %s",async reason=>{
  const read=vi.fn().mockResolvedValueOnce({color:"#112233"}).mockResolvedValue(null);
  const bridge=new EnvironmentLightingBridge(read),old=controller(),next=reason==="replaced"?controller():old;
  bridge.configure(old,true,1,true);
  await vi.advanceTimersByTimeAsync(0);
  if(reason==="replaced")bridge.configure(next,true,1,true);
  else {
    bridge.configure(old,reason!=="disabled",1,reason!=="paused");
    bridge.configure(old,true,1,true);
  }
  expect(old.setEnvironmentLighting).toHaveBeenLastCalledWith(null);
  const calls=next.setEnvironmentLighting.mock.calls.length;
  await vi.advanceTimersByTimeAsync(250);
  bridge.configure(next,true,.5,true);
  await vi.advanceTimersByTimeAsync(0);
  expect(next.setEnvironmentLighting).toHaveBeenCalledTimes(calls);
  bridge.destroy();
});

it("destroy is idempotent, cancels timers and discards pending results",async()=>{
  const first=pending(),read=vi.fn(()=>first.promise),bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,.2,true);
  bridge.destroy();bridge.destroy();
  first.resolve({color:"#ffffff"});
  bridge.configure(target,true,.2,true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledOnce();
  expect(target.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith(null);
});

it("passes strengths above 100% through to the runtime without changing the sampling rate",async()=>{
  const read=vi.fn(async()=>({color:"#123456"})),bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,2,true);
  await vi.advanceTimersByTimeAsync(0);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#123456",strength:2});
  await vi.advanceTimersByTimeAsync(249);
  expect(read).toHaveBeenCalledOnce();
  bridge.configure(target,true,1.5,true);
  await vi.advanceTimersByTimeAsync(0);
  expect(target.setEnvironmentLighting).toHaveBeenLastCalledWith({color:"#123456",strength:1.5});
  bridge.destroy();
});

it("publishes only current-generation diagnostics and clears points without clearing retained lighting",async()=>{
  const late=pending(),sampled=vi.fn(),valid={color:"#204a9e",patches:[{left:100,top:100,width:12,height:12}],viewportWidth:800,viewportHeight:600};
  const read=vi.fn().mockResolvedValueOnce(valid).mockResolvedValueOnce(null).mockReturnValueOnce(late.promise);
  const target=controller(),bridge=new EnvironmentLightingBridge(read,sampled);
  bridge.configure(target,true,1,true);await vi.advanceTimersByTimeAsync(0);
  expect(sampled).toHaveBeenLastCalledWith(valid);
  await vi.advanceTimersByTimeAsync(250);
  expect(sampled).toHaveBeenLastCalledWith(null);
  expect(target.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith({color:valid.color,strength:1});
  await vi.advanceTimersByTimeAsync(250);bridge.configure(target,false,1,true);sampled.mockClear();late.resolve(valid);
  await vi.advanceTimersByTimeAsync(1);expect(sampled).not.toHaveBeenCalled();
  bridge.destroy();expect(sampled).toHaveBeenLastCalledWith(null);
});

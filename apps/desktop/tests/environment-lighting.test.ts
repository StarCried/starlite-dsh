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

it("discards old-strength results and restores neutral after unavailable or malformed samples",async()=>{
  const first=pending(),read=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({color:"#abcdef"}).mockRejectedValueOnce(Error("unavailable")).mockResolvedValueOnce({color:"red"}).mockResolvedValue(null);
  const bridge=new EnvironmentLightingBridge(read),target=controller();
  bridge.configure(target,true,.2,true);
  bridge.configure(target,true,.6,true);
  first.resolve({color:"#111111"});
  await vi.advanceTimersByTimeAsync(1);
  expect(target.setEnvironmentLighting).toHaveBeenCalledExactlyOnceWith({color:"#abcdef",strength:.6});
  await vi.advanceTimersByTimeAsync(750);
  expect(target.setEnvironmentLighting.mock.calls.slice(1)).toEqual([[null],[null],[null]]);
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

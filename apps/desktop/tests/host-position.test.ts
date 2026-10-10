import {describe,expect,it,vi} from "vitest";
import {HostPositionBridge} from "../src/host-position.js";

describe("host position synchronization",()=>{
  it("discards a read from before a viewport resize",async()=>{
    let finish!:(position:{x:number;y:number})=>void;
    const publish=vi.fn(),bridge=new HostPositionBridge(()=>new Promise(done=>{finish=done}),()=>true,publish);
    const pending=bridge.sync();bridge.invalidate();finish({x:10,y:20});await pending;
    expect(publish).not.toHaveBeenCalled();
  });
  it("uses only the newest position when move notifications finish out of order",async()=>{
    const reads:Array<(position:{x:number;y:number})=>void>=[],publish=vi.fn();
    const bridge=new HostPositionBridge(()=>new Promise(done=>{reads.push(done)}),()=>true,publish);
    const older=bridge.sync(),newer=bridge.sync();
    reads[1]!({x:30,y:40});await newer;reads[0]!({x:10,y:20});await older;
    expect(publish).toHaveBeenCalledOnce();expect(publish).toHaveBeenCalledWith({x:30,y:40});
  });
  it("waits for geometry and an installed controller",async()=>{
    let available=false;
    const read=vi.fn(async()=>({x:10,y:20})),publish=vi.fn();
    const bridge=new HostPositionBridge(read,()=>available,publish);
    await bridge.sync();expect(read).not.toHaveBeenCalled();
    available=true;const pending=bridge.sync();available=false;await pending;
    expect(publish).not.toHaveBeenCalled();
    available=true;await bridge.sync();expect(publish).toHaveBeenCalledOnce();
  });
});

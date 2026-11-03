import {randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {startStatusServer,type StatusServer} from "../../../packages/dsh-plugin/src/server.js";
import {StatusConnection} from "../src/connection.js";

// Real loopback HTTP and authenticated SSE, without a DSH/model API request.
it("reuses one connection controller across real Host shutdown/restart without the offline lease",async()=>{
  const servers:StatusServer[]=[];
  const callbacks={onSnapshot:vi.fn(),onConnected:vi.fn(),onDisconnected:vi.fn(),onConflict:vi.fn()};
  const connection=new StatusConnection(callbacks);
  const host=async()=>{
    const server=await startStatusServer({async start(emit){emit({protocolVersion:1,sequence:0,emittedAt:1,state:"idle"});},async stop(){}});
    servers.push(server);
    return {server,url:`dsh-inochi2d-pet://connect?port=${server.port}&token=${server.token}&instance=${randomUUID()}`};
  };
  try {
    let current=await host();connection.connect(current.url);
    await vi.waitFor(()=>expect(callbacks.onSnapshot).toHaveBeenCalledTimes(1));
    for(let index=0;index<3;index++){
      const started=performance.now();
      await current.server.close();
      await vi.waitFor(()=>expect(callbacks.onDisconnected).toHaveBeenCalledTimes(index+1));
      expect(connection.connect(current.url)).toBe("unchanged");
      current=await host();expect(connection.connect(current.url)).toBe("accepted");
      await vi.waitFor(()=>expect(callbacks.onSnapshot).toHaveBeenCalledTimes(index+2));
      expect(performance.now()-started).toBeLessThan(1500);
    }
    expect(callbacks.onConflict).not.toHaveBeenCalled();
    const next=await host();expect(connection.connect(next.url)).toBe("conflict");
    const started=performance.now();await current.server.close();
    await vi.waitFor(()=>expect(callbacks.onSnapshot).toHaveBeenCalledTimes(5));
    expect(performance.now()-started).toBeLessThan(1500);
    expect(callbacks.onConnected).toHaveBeenCalledTimes(5);
    expect(callbacks.onConflict).toHaveBeenCalledOnce();
  } finally {connection.stop();await Promise.all(servers.map(server=>server.close()));}
});

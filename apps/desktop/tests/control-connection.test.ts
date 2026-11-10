import {expect,it,vi} from "vitest";
import {StatusConnection,consumeSseFrames} from "../src/connection.js";
import {CONTROL_LEASE_MS,type ControlDesktopReport} from "@starcried/starlite-dsh-protocol";
const leaseId="123e4567-e89b-42d3-a456-426614174000",commandId="123e4567-e89b-42d3-a456-426614174001";
const url=`dsh-inochi2d-pet://connect?port=45678&token=${"a".repeat(43)}&instance=${leaseId}`;
it("dispatches strict control frames separately from snapshots and sends authenticated capability/ack/release requests",async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;
  const request=vi.fn<typeof fetch>(async input=>String(input).endsWith("/events")?new Response(new ReadableStream({start(controller){stream=controller;}}),{headers:{"Content-Type":"text/event-stream"}}):new Response(null,{status:204}));
  const onControl=vi.fn(),onSnapshot=vi.fn(),onConnected=vi.fn(),connection=new StatusConnection({onControl,onSnapshot,onConnected,onDisconnected:()=>{}},request);
  connection.connect(url);await vi.waitFor(()=>expect(onConnected).toHaveBeenCalledOnce());
  try{
    const frame={controlVersion:1,sequence:1,leaseId,commandId,leaseMs:CONTROL_LEASE_MS,kind:"acquire",sessionTitle:"Session"};
    stream.enqueue(new TextEncoder().encode(`event: control\ndata: ${JSON.stringify(frame)}\n\n`));
    await vi.waitFor(()=>expect(onControl).toHaveBeenCalledWith(frame));expect(onSnapshot).not.toHaveBeenCalled();
    const report:ControlDesktopReport={controlVersion:1,enabled:true,available:true,model:{revision:commandId,title:"Model",animations:[{name:"Wave",durationMs:1200}]},preferences:{bubblesVisible:true,pointerEnabled:true,scale:1}};
    await connection.reportControl(report);await connection.acknowledgeControl({controlVersion:1,leaseId,commandId,status:"started"});await connection.releaseControl({leaseId,reason:"user"});await connection.openControlSession(leaseId);
    expect(request.mock.calls.slice(1).map(([url])=>url)).toEqual(["http://127.0.0.1:45678/v1/control/desktop","http://127.0.0.1:45678/v1/control/ack","http://127.0.0.1:45678/v1/control/release","http://127.0.0.1:45678/v1/control/open"]);
    for(const [,options] of request.mock.calls.slice(1))expect(options).toMatchObject({method:"POST",headers:{Authorization:`Bearer ${"a".repeat(43)}`}});
    const count=request.mock.calls.length;
    await expect(connection.reportControl({...report,preferences:{...report.preferences,scale:NaN}})).rejects.toThrow();expect(request).toHaveBeenCalledTimes(count);
    expect(consumeSseFrames('event: control\ndata: {}\n\nevent: unknown\ndata: {}\n\n').events).toEqual([{event:"control",data:"{}"}]);
  }finally{connection.stop();stream.close();}
});

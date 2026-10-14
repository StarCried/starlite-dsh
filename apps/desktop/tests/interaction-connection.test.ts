import {it,expect,vi} from "vitest";
import {StatusConnection} from "../src/connection.js";
const ref="123e4567-e89b-42d3-a456-426614174000",id="123e4567-e89b-42d3-a456-426614174001";
const url=`dsh-inochi2d-pet://connect?port=45678&token=${"a".repeat(43)}&instance=${ref}`;
it("uses bounded authenticated questions and only an opaque navigation action",async()=>{
  const request=vi.fn<typeof fetch>(async input=>{
    if(String(input).endsWith("/events"))return new Response(new ReadableStream(),{headers:{"Content-Type":"text/event-stream"}});
    if(String(input).includes("?request="))return new Response(JSON.stringify({interactionVersion:1,requestId:id,sessionRef:ref,questions:[{id:"q",question:"选择",options:[{label:"A"}],multiSelect:false}],wait:{state:"timed",deadline:12001,issuedAt:1,callId:"PRIVATE"},path:"PRIVATE"}),{headers:{"Content-Type":"application/json"}});
    return new Response(null,{status:204});
  });
  const connected=vi.fn(),connection=new StatusConnection({onSnapshot:()=>{},onConnected:connected,onDisconnected:()=>{}},request);connection.connect(url);await vi.waitFor(()=>expect(connected).toHaveBeenCalledOnce());
  try{
    const interaction=await connection.readInteraction(id);expect(interaction.wait).toEqual({state:"timed",deadline:12001,issuedAt:1});expect(JSON.stringify(interaction)).not.toContain("PRIVATE");
    await connection.answerInteraction({requestId:id,sessionRef:ref,answers:[{id:"q",selected:["A"]}]});
    await connection.openSession(ref);const call=request.mock.calls.at(-1)!;expect(call[0]).toBe("http://127.0.0.1:45678/v1/session/open");expect(call[1]).toMatchObject({method:"POST",body:JSON.stringify({sessionRef:ref}),headers:{Authorization:`Bearer ${"a".repeat(43)}`,"Content-Type":"application/json"}});
    await connection.openWebUi();const home=request.mock.calls.at(-1)!;expect(home[0]).toBe("http://127.0.0.1:45678/v1/web/open");expect(home[1]).toMatchObject({method:"POST",body:"{}",headers:{Authorization:`Bearer ${"a".repeat(43)}`,"Content-Type":"application/json"}});
    const calls=request.mock.calls.length;
    await expect(connection.openSession("http://evil.invalid/")).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(calls);
    request.mockResolvedValueOnce(new Response(null,{status:409}));await expect(connection.openSession(ref)).rejects.toThrow("action unavailable");expect(request.mock.calls.at(-1)![0]).toBe("http://127.0.0.1:45678/v1/session/open");expect(request).toHaveBeenCalledTimes(calls+1);
    request.mockResolvedValueOnce(new Response("x".repeat(32769),{headers:{"Content-Type":"application/json"}}));await expect(connection.readInteraction(id)).rejects.toThrow("too large");
    request.mockImplementationOnce(async (_input,options)=>new Promise((_resolve,reject)=>options!.signal!.addEventListener("abort",()=>reject(Error("cancelled")),{once:true})));
    const pending=expect(connection.readInteraction(id)).rejects.toThrow("cancelled");connection.stop();await pending;
  }finally{connection.stop()}
  const calls=request.mock.calls.length;await expect(connection.openWebUi()).rejects.toThrow("disconnected");expect(request).toHaveBeenCalledTimes(calls);
});

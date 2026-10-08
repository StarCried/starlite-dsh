import {expect,it} from "vitest";
import {parsePetAnswer,parsePetInteraction,parsePetSnapshot,MAX_INTERACTION_BYTES} from "../src/index.js";
const requestId="15c3a508-c0c7-4a6e-8c89-985e13ef5a72",sessionRef="25c3a508-c0c7-4a6e-8c89-985e13ef5a72";
const request={interactionVersion:1,requestId,sessionRef,questions:[{id:"choice",question:"Choose",options:[{label:"A"},{label:"B"}],multiSelect:false},{id:"many",question:"Many",options:[{label:"C"},{label:"D"}],multiSelect:true}]};
it("canonicalizes structured questions and strips unrelated host data",()=>{
 const canonical=parsePetInteraction({...request,agent:{id:"PRIVATE"},signal:{},questions:request.questions.map(q=>({...q,args:{secret:"PRIVATE"}}))});expect(canonical).toEqual(request);expect(JSON.stringify(canonical)).not.toContain("PRIVATE");
 expect(parsePetSnapshot({protocolVersion:1,state:"working",sequence:1,emittedAt:1,session:{ref:sessionRef,title:"Title",id:"PRIVATE"},activity:"editing",inputRequest:requestId})).toMatchObject({session:{ref:sessionRef,title:"Title"},activity:"editing"});
});
it("accepts exact single, multiple and multiline custom answers",()=>{
 const answer={requestId,sessionRef,answers:[{id:"choice",selected:["A"]},{id:"many",selected:["C","D"],custom:"more\ncontext"}]};expect(parsePetAnswer(answer,parsePetInteraction(request))).toEqual(answer);
 expect(parsePetAnswer({...answer,answers:[{id:"choice",selected:[],custom:"custom"},{id:"many",selected:["C"]}]},parsePetInteraction(request)).answers[0]?.custom).toBe("custom");
});
it("rejects stale, duplicate, invalid and incomplete selections",()=>{
 const good={requestId,sessionRef,answers:[{id:"choice",selected:["A"]},{id:"many",selected:["C"]}]};
 for(const bad of [{...good,sessionRef:requestId},{...good,answers:[good.answers[0]]},{...good,answers:[good.answers[0],good.answers[0]]},{...good,answers:[{id:"choice",selected:["A","B"]},good.answers[1]]},{...good,answers:[{id:"choice",selected:["X"]},good.answers[1]]},{...good,answers:[{id:"choice",selected:["A"],custom:"also"},good.answers[1]]}])expect(()=>parsePetAnswer(bad,parsePetInteraction(request))).toThrow();
});
it("bounds identities, arrays, Unicode wire size and control bytes",()=>{
 for(const bad of [{...request,requestId:"real-session-id"},{...request,questions:Array(9).fill(request.questions[0])},{...request,questions:[{...request.questions[0],question:"\u0000bad"}]},{...request,questions:Array.from({length:8},(_,i)=>({...request.questions[0],id:String(i),detail:"字".repeat(8192)}))}])expect(()=>parsePetInteraction(bad)).toThrow();
 expect(MAX_INTERACTION_BYTES).toBe(32768);expect(()=>parsePetSnapshot({protocolVersion:1,state:"working",sequence:1,emittedAt:1,inputRequest:requestId})).toThrow();
});

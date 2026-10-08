import { expect, it } from "vitest";
import { validDemoMappings } from "../release-mappings.mjs";
const defaults = () => ({idle:"Idle",working:"Working",completed:null,error:null,blocked:null,approval:null,click:["Wave","Bow"],ambient:["Stretch"]});
it("accepts the current release defaults with randomized click and idle pools",()=>{
 expect(validDemoMappings(defaults())).toBe(true);
 expect(validDemoMappings({...defaults(),click:[],ambient:[]})).toBe(true);
 expect(validDemoMappings({...defaults(),click:"Wave",ambient:undefined})).toBe(true);
});
it("rejects retired Thinking and incomplete or empty release state mappings",()=>{
 for(const patch of [{thinking:"Thinking"},{working:undefined},{working:""},{idle:""},{surprise:"Surprise"}])expect(validDemoMappings({...defaults(),...patch})).toBe(false);
});
it("rejects duplicate, oversized and invalid motion pools before staging",()=>{
 for(const pool of [["Wave","Wave"],Array.from({length:21},(_,i)=>`Motion${i}`),[""],[null],"Stretch"]){
  expect(validDemoMappings({...defaults(),ambient:pool})).toBe(false);
 }
});

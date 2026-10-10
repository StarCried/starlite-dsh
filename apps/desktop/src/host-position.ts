interface Position {x:number;y:number}

/** Read the current window anchor; queued move events may describe an older viewport. */
export class HostPositionBridge {
  #generation=0;
  constructor(
    readonly read:()=>Promise<Position>,
    readonly available:()=>boolean,
    readonly publish:(position:Position)=>void,
  ){}
  invalidate():void{++this.#generation;}
  async sync():Promise<void>{
    const generation=++this.#generation;
    if(!this.available())return;
    const position=await this.read();
    if(generation===this.#generation&&this.available())this.publish(position);
  }
}

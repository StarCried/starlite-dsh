interface Position {x:number;y:number}

/** Read the current window anchor; queued move events may describe an older viewport. */
export class HostPositionBridge<T extends Position = Position> {
  #generation=0;
  constructor(
    readonly read:()=>Promise<T>,
    readonly available:()=>boolean,
    readonly publish:(position:T)=>void,
  ){}
  invalidate():void{++this.#generation;}
  async sync():Promise<void>{
    const generation=++this.#generation;
    if(!this.available())return;
    const position=await this.read();
    if(generation===this.#generation&&this.available())this.publish(position);
  }
}

interface MonitorBounds {
  position:Position;
  size:{width:number;height:number};
  workArea:{position:Position};
}

/** Select by the fixed portrait, rather than by the temporary bubble margins. */
export function screenSpaceAboveModel(point:Position,scale:number,monitors:readonly MonitorBounds[]):number|undefined {
  if (!Number.isFinite(scale) || scale<=0) return undefined;
  const center={x:(point.x+160)*scale,y:(point.y+240)*scale};
  const monitor=monitors.find(value=>center.x>=value.position.x&&center.x<value.position.x+value.size.width
    &&center.y>=value.position.y&&center.y<value.position.y+value.size.height);
  return monitor ? point.y-monitor.workArea.position.y/scale : undefined;
}

/** Fit a bubble after layout settles. Coalesce requests, reread before moving,
 * and bound layout retries so a failed native call cannot start a retry loop. */
export class ScreenClearanceBridge<T extends Position> {
  #generation=0;
  #active:number|undefined;
  constructor(
    readonly read:()=>Promise<T>,
    readonly ready:()=>Promise<unknown>,
    readonly available:()=>boolean,
    readonly correction:(position:T)=>number,
    readonly move:(position:T,delta:number)=>Promise<void>,
    readonly changed:()=>Promise<void>,
  ){}
  invalidate():void{++this.#generation;this.#active=undefined;}
  async sync():Promise<void>{
    const generation=this.#generation;
    if(this.#active!==undefined)return;
    this.#active=generation;
    const current=()=>generation===this.#generation&&this.available();
    try{
      for(let attempt=0;attempt<2;attempt++){
        await this.ready();if(!current())return;
        const position=await this.read();if(!current())return;
        if(this.correction(position)<=0)return;
        await this.ready();if(!current())return;
        const latest=await this.read();if(!current())return;
        const remaining=this.correction(latest);
        if(!current())continue;
        if(remaining>0)await this.move(latest,remaining);
        if(current())await this.changed();
        return;
      }
    }catch{
      // A later genuine layout or move may try again; do not retry a failure.
    }finally{if(this.#active===generation)this.#active=undefined;}
  }
}

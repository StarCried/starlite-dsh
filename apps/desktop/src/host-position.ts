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

/** Select by the fixed portrait, regardless of the transparent margins. */
export function screenSpaceAboveModel(point:Position,scale:number,monitors:readonly MonitorBounds[],size={width:320,height:480}):number|undefined {
  if (!Number.isFinite(scale) || scale<=0) return undefined;
  const center={x:(point.x+size.width/2)*scale,y:(point.y+size.height/2)*scale};
  const monitor=monitors.find(value=>center.x>=value.position.x&&center.x<value.position.x+value.size.width
    &&center.y>=value.position.y&&center.y<value.position.y+value.size.height);
  return monitor ? point.y-monitor.workArea.position.y/scale : undefined;
}

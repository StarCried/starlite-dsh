interface Point {x:number;y:number}
interface Size {width:number;height:number}
interface MenuMonitor {position:Point;size:Size;workArea:{position:Point;size?:Size}}

/** Choose the display under the actual click, before the menu is placed. A
 * provisional menu can extend onto another monitor or beyond every display. */
export function menuWorkArea(origin:Point,dpi:number,viewport:Size,pointer:Point,monitors:readonly MenuMonitor[]):{left:number;top:number;right:number;bottom:number}|undefined {
  if(!Number.isFinite(dpi)||dpi<=0)return undefined;
  const point={x:origin.x+pointer.x*dpi,y:origin.y+pointer.y*dpi};
  const intersection=(monitor:MenuMonitor)=>Math.max(0,Math.min(origin.x+viewport.width*dpi,monitor.position.x+monitor.size.width)-Math.max(origin.x,monitor.position.x))
    *Math.max(0,Math.min(origin.y+viewport.height*dpi,monitor.position.y+monitor.size.height)-Math.max(origin.y,monitor.position.y));
  const monitor=monitors.find(m=>point.x>=m.position.x&&point.x<m.position.x+m.size.width&&point.y>=m.position.y&&point.y<m.position.y+m.size.height)
    ??monitors.reduce<MenuMonitor|undefined>((best,m)=>intersection(m)>intersection(best??m)?m:best??m,undefined);
  if(!monitor)return undefined;
  const area=monitor.workArea,size=area.size??monitor.size;
  const bounds={
    left:Math.max(0,(area.position.x-origin.x)/dpi)+8,
    top:Math.max(0,(area.position.y-origin.y)/dpi)+8,
    right:Math.min(viewport.width,(area.position.x+size.width-origin.x)/dpi)-8,
    bottom:Math.min(viewport.height,(area.position.y+size.height-origin.y)/dpi)-8,
  };
  return bounds.right>bounds.left&&bounds.bottom>bounds.top?bounds:undefined;
}

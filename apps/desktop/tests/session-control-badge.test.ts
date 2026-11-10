// @vitest-environment happy-dom
import {expect,it,vi} from "vitest";
import {SessionControlBadge} from "../src/session-control-badge.js";
it("shows the controlling session as plain text and provides an exit independent of speech bubbles",()=>{
  const exit=vi.fn(),badge=new SessionControlBadge(exit);
  try{
    badge.owner("<img src=x> session");badge.place({left:20,top:40,width:200,height:300});
    expect(badge.visible).toBe(true);expect(badge.rect).toEqual({left:20,top:308,width:200,height:30});
    expect(badge.element.querySelector("img")).toBeNull();expect(badge.element.textContent).toContain("<img src=x>");
    expect(badge.element.hasAttribute("data-environment-exclusion")).toBe(true);
    badge.element.querySelector("button")!.click();expect(exit).toHaveBeenCalledOnce();
    badge.show(false);expect(badge.visible).toBe(false);badge.show(true);expect(badge.visible).toBe(true);
    badge.owner(undefined);expect(badge.visible).toBe(false);
  }finally{badge.destroy();}
});

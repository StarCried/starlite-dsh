import {describe,expect,it,vi} from "vitest";
import {openDisplayedDsh} from "../src/pet.js";

describe("double-click DSH destination",()=>{
  it("opens the Web UI when no session is displayed",async()=>{
    const connection={openSession:vi.fn(async()=>{}),openWebUi:vi.fn(async()=>{})};
    await openDisplayedDsh(connection);
    expect(connection.openWebUi).toHaveBeenCalledOnce();
    expect(connection.openSession).not.toHaveBeenCalled();
  });
  it("targets the displayed session and never substitutes the homepage after a failure",async()=>{
    const failure=new Error("session no longer exists");
    const connection={openSession:vi.fn(async()=>{throw failure}),openWebUi:vi.fn(async()=>{})};
    await expect(openDisplayedDsh(connection,"123e4567-e89b-42d3-a456-426614174000")).rejects.toBe(failure);
    expect(connection.openSession).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000");
    expect(connection.openWebUi).not.toHaveBeenCalled();
  });
});

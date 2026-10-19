import {describe, expect, it} from "vitest";
import {webServerContract} from "../dsh-webserver-contract.mjs";

const declaration = port => `get port(): ${port}; get host(): Config['host'];`;

describe("DSH loopback listener declaration contract", () => {
  it.each(["number", "number | undefined"])("accepts the reviewed numeric port lifecycle (%s)", port => {
    expect(webServerContract(declaration(port))).toEqual([]);
  });
  it.each(["string", "number | null", "number | undefined | string", "Promise<number>", "any"])("rejects changed listener values (%s)", port => {
    expect(webServerContract(declaration(port))).toContain("loopback web server port");
  });
  it("requires both public getters, not similarly named methods or a missing source", () => {
    expect(webServerContract("port(): number; get host(): Config['host'];")).toContain("loopback web server port");
    expect(webServerContract("get port(): number;")).toEqual(["loopback web server host"]);
    expect(webServerContract(undefined)).toHaveLength(2);
  });
});

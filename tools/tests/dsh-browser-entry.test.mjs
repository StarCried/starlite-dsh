import {describe, expect, it} from "vitest";
import {browserClientEntry} from "../dsh-browser-entry.mjs";

describe("official DSH browser client entry selection", () => {
  it("uses the declared browser entry even when Node is listed first", () => {
    expect(browserClientEntry({"./client": {types: "./lib/types/client.d.ts", node: "./lib/client.node.js",
      browser: "./lib/client.browser.js", default: "./lib/client.browser.js"}})).toBe("./lib/client.browser.js");
  });
  it("uses the public default or string entry in older packages", () => {
    expect(browserClientEntry({"./client": {types: "./lib/types/client.d.ts", default: "./lib/client.js"}})).toBe("./lib/client.js");
    expect(browserClientEntry({"./client": "./lib/client.js"})).toBe("./lib/client.js");
  });
  it.each([undefined, {}, {"./client": {node: "./lib/client.node.js"}}, {"./client": {browser: {import: "./client.js"}}},
    {"./client": "../outside.js"}])("rejects undeclared browser formats rather than executing a Node entry", exports => {
    expect(() => browserClientEntry(exports)).toThrow("DSH browser client export unavailable");
  });
});

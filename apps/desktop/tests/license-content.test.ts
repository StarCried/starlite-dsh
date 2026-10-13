// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderLicenseContent } from "../src/license-content.js";
import { showModelLicense } from "../src/model-license-dialog.js";

afterEach(() => document.body.replaceChildren());

describe("model license display", () => {
  it("formats headings, clauses and emphasis without displaying Markdown markers", () => {
    const content = renderLicenseContent("# 使用许可\r\n\r\n个人 **非商业** 使用。\r\n\r\n## 允许\r\n\r\n1. 运行桌宠。\r\n2. 运行博客。\r\n\r\n- 保留署名。\r\n- 不可再分发。");
    expect(content.querySelector("h3")!.textContent).toBe("使用许可");
    expect(content.querySelector("h4")!.textContent).toBe("允许");
    expect(content.querySelector("strong")!.textContent).toBe("非商业");
    expect(content.querySelectorAll("ol li")).toHaveLength(2);
    expect(content.querySelectorAll("ul li")).toHaveLength(2);
    expect(content.textContent).not.toContain("#");
    expect(content.textContent).not.toContain("**");
    expect(content.textContent).not.toContain("1.");
  });

  it("never interprets HTML, image markup, scripts or unsafe links", () => {
    const hostile = '<img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n[unsafe](javascript:alert) [file](file:///private) [data](data:text/html,evil) [creds](https://user:pass@example.org)';
    const content = renderLicenseContent(hostile);
    expect(content.querySelector("img, script, iframe, a")).toBeNull();
    expect(content.textContent).toContain("<img");
    expect(content.textContent).toContain("javascript:alert");
  });

  it("allows only explicit HTTP license links without credentials", () => {
    const content = renderLicenseContent("[许可原文](https://example.org/license?q=1) [relative](/private) `CC_BY_NC`");
    const link = content.querySelector("a")!;
    expect(link.href).toBe("https://example.org/license?q=1");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.target).toBe("_blank");
    expect(content.querySelectorAll("a")).toHaveLength(1);
    expect(content.querySelector("code")!.textContent).toBe("CC_BY_NC");
  });

  it("keeps literal escaped punctuation, paragraphs, quotes and code readable", () => {
    const content = renderLicenseContent("\\# 字面标题\n\n> 引用内容\n> 第二行\n\n```text\n<script>literal</script>\n```\n\n段落一\n段落二");
    expect(content.querySelector("h3")).toBeNull();
    expect(content.querySelector("blockquote")!.textContent).toBe("引用内容\n第二行");
    expect(content.querySelector("pre code")!.textContent).toBe("<script>literal</script>");
    expect(content.querySelectorAll("p")).toHaveLength(2);
  });

  it("unescapes CommonMark ASCII punctuation in model metadata", () => {
    const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    const source = [...punctuation].map(character => `\\${character}`).join("");
    const content = renderLicenseContent(`作者 \\#1\n\n${source}`);
    expect(content.querySelector("p")!.textContent).toBe("作者 #1");
    expect(content.querySelectorAll("p")[1]!.textContent).toBe(punctuation);
  });

  it("displays a formatted model license and closes cleanly", () => {
    showModelLicense({title: "角色 A", text: "# 许可\n\n仅供 **个人** 使用。"});
    expect(document.querySelector("dialog .license-content h3")!.textContent).toBe("许可");
    expect(document.querySelector("dialog pre")).toBeNull();
    document.querySelector<HTMLButtonElement>("dialog button")!.click();
    expect(document.querySelector("dialog")).toBeNull();
  });
});

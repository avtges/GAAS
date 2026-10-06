import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown, parseBlocks } from "@/components/markdown";

const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));

describe("chat markdown renderer", () => {
  it("renders bold, italic, code, lists and paragraphs", () => {
    const out = html("**Totals** for _Sep_\n\n- one `a`\n- two\n\n1. first\n2. second\nplain");
    expect(out).toContain("<strong>Totals</strong>");
    expect(out).toContain("<em>Sep</em>");
    expect(out).toContain("<code");
    expect(out).toMatch(/<ul[^>]*><li>one/);
    expect(out).toMatch(/<ol[^>]*><li>first<\/li><li>second<\/li><\/ol>/);
    expect(parseBlocks("a\nb\n\nc").filter((b) => b.type === "p")).toHaveLength(2);
  });
  it("escapes HTML and script from model output", () => {
    const out = html('<img src=x onerror="alert(1)"> **<script>alert(2)</script>**');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
  it("does not treat snake_case identifiers or multiplication as emphasis", () => {
    const out = html("primary_google_ads_conversion is not configured; 2 * 3 = 6");
    expect(out).not.toContain("<em>");
  });
});

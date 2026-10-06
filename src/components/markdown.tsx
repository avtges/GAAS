import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe markdown renderer for assistant answers: paragraphs, headings (#..###),
 * bullet and numbered lists, **bold**, _italic_ / *italic*, and `code`. It builds React
 * elements directly and never injects HTML, so model output cannot inject markup or script.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])_[^_\n]+_(?![\w])|(?<![\w*])\*[^*\n]+\*(?![\w*]))/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyPrefix}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-zinc-100 px-1 text-[0.85em]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { type: "p"; lines: string[] } | { type: "ul"; items: string[] } | { type: "ol"; items: string[] } | { type: "h"; level: number; text: string };

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const prev = blocks[blocks.length - 1];
    if (!line.trim()) {
      blocks.push({ type: "p", lines: [] });
    } else if (heading) {
      blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
    } else if (bullet) {
      if (prev?.type === "ul") prev.items.push(bullet[1]);
      else blocks.push({ type: "ul", items: [bullet[1]] });
    } else if (numbered) {
      if (prev?.type === "ol") prev.items.push(numbered[1]);
      else blocks.push({ type: "ol", items: [numbered[1]] });
    } else if (prev?.type === "p") {
      prev.lines.push(line);
    } else {
      blocks.push({ type: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => b.type !== "p" || b.lines.length > 0);
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2">
      {blocks.map((b, bi) => {
        const k = `b${bi}`;
        if (b.type === "h") return <p key={k} className="font-semibold">{inline(b.text, k)}</p>;
        if (b.type === "ul")
          return (
            <ul key={k} className="list-disc space-y-0.5 pl-5">
              {b.items.map((it, ii) => <li key={ii}>{inline(it, `${k}-${ii}`)}</li>)}
            </ul>
          );
        if (b.type === "ol")
          return (
            <ol key={k} className="list-decimal space-y-0.5 pl-5">
              {b.items.map((it, ii) => <li key={ii}>{inline(it, `${k}-${ii}`)}</li>)}
            </ol>
          );
        return (
          <p key={k}>
            {b.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, `${k}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

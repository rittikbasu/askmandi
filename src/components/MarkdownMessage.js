import { useMemo } from "react";

const escapeText = (text) => String(text ?? "");

const renderInlineMarkdown = (text, styles) => {
  const s = escapeText(text);
  const nodes = [];
  let i = 0;

  const pushText = (value) => {
    if (value) nodes.push(value);
  };

  while (i < s.length) {
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end !== -1) {
        nodes.push(
          <code key={`code_${i}`} className={styles.inlineCode}>
            {s.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    if (s.startsWith("**", i)) {
      const end = s.indexOf("**", i + 2);
      if (end !== -1) {
        nodes.push(
          <strong key={`b_${i}`} className={styles.strong}>
            {s.slice(i + 2, end)}
          </strong>
        );
        i = end + 2;
        continue;
      }
    }

    if (s[i] === "*" && !s.startsWith("**", i)) {
      const end = s.indexOf("*", i + 1);
      if (end !== -1) {
        nodes.push(
          <em key={`i_${i}`} className={styles.em}>
            {s.slice(i + 1, end)}
          </em>
        );
        i = end + 1;
        continue;
      }
    }

    if (s[i] === "[") {
      const mid = s.indexOf("](", i + 1);
      if (mid !== -1) {
        const end = s.indexOf(")", mid + 2);
        if (end !== -1) {
          const label = s.slice(i + 1, mid);
          const url = s.slice(mid + 2, end);
          if (url.startsWith("http://") || url.startsWith("https://")) {
            nodes.push(
              <a
                key={`a_${i}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                className={styles.link}
              >
                {label || url}
              </a>
            );
            i = end + 1;
            continue;
          }
        }
      }
    }

    const specials = [
      s.indexOf("`", i),
      s.indexOf("**", i),
      s.indexOf("*", i),
      s.indexOf("[", i),
    ].filter((idx) => idx !== -1);

    const next = specials.length ? Math.min(...specials) : -1;

    if (next === -1) {
      pushText(s.slice(i));
      break;
    }

    if (next > i) {
      pushText(s.slice(i, next));
      i = next;
      continue;
    }

    pushText(s[i]);
    i += 1;
  }

  return nodes;
};

export default function MarkdownMessage({ content, variant = "assistant" }) {
  const isUser = variant === "user";
  const inlineStyles = isUser
    ? {
        inlineCode:
          "rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[0.92em] text-zinc-900",
        strong: "font-semibold text-black",
        em: "italic text-zinc-900",
        link: "text-black underline decoration-zinc-400 underline-offset-4 hover:decoration-zinc-700",
      }
    : {
        inlineCode:
          "rounded bg-black/40 px-1.5 py-0.5 font-mono text-[0.92em] text-zinc-100",
        strong: "font-semibold text-zinc-50",
        em: "italic text-zinc-100",
        link: "underline decoration-zinc-500 underline-offset-4 hover:decoration-zinc-200",
      };

  const paragraphClass = isUser
    ? "text-sm text-black"
    : "text-sm text-zinc-100";
  const listClass = isUser ? "text-sm text-black" : "text-sm text-zinc-100";
  const quoteTextClass = isUser
    ? "text-sm text-black"
    : "text-sm text-zinc-200";
  const quoteBorderClass = isUser ? "border-zinc-300" : "border-zinc-700";
  const hrClass = isUser
    ? "border-zinc-200 opacity-80"
    : "border-zinc-800 opacity-80";

  const headingClasses = {
    1: isUser
      ? "text-base font-semibold text-black"
      : "text-base font-semibold text-zinc-50",
    2: isUser
      ? "text-sm font-semibold text-black"
      : "text-sm font-semibold text-zinc-50",
    3: isUser
      ? "text-sm font-medium text-zinc-800"
      : "text-sm font-medium text-zinc-100",
  };

  const blocks = useMemo(() => {
    const src = escapeText(content);
    const lines = src.split("\n");
    const parsed = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
      if (headingMatch) {
        parsed.push({
          type: "heading",
          level: headingMatch[1].length,
          text: headingMatch[2],
        });
        i += 1;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
          i += 1;
        }
        parsed.push({ type: "ul", items });
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i += 1;
        }
        parsed.push({ type: "ol", items });
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quotes = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quotes.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        parsed.push({ type: "quote", text: quotes.join("\n") });
        continue;
      }

      if (/^\s*---\s*$/.test(line)) {
        parsed.push({ type: "hr" });
        i += 1;
        continue;
      }

      // Table detection
      if (line.includes("|") && line.trim().startsWith("|")) {
        const tableLines = [];
        while (i < lines.length && lines[i].includes("|")) {
          tableLines.push(lines[i]);
          i += 1;
        }
        if (tableLines.length >= 2) {
          // Parse header
          const headerLine = tableLines[0];
          const headers = headerLine
            .split("|")
            .map((h) => h.trim())
            .filter(Boolean);

          // Skip separator line (|---|---|)
          const dataStartIdx = tableLines[1].includes("---") ? 2 : 1;

          // Parse rows
          const rows = tableLines.slice(dataStartIdx).map((rowLine) =>
            rowLine
              .split("|")
              .map((c) => c.trim())
              .filter((_, idx, arr) => idx > 0 && idx < arr.length)
          );

          parsed.push({ type: "table", headers, rows });
          continue;
        }
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim()) {
        if (
          /^(#{1,3})\s+/.test(lines[i]) ||
          /^\s*[-*]\s+/.test(lines[i]) ||
          /^\s*\d+\.\s+/.test(lines[i]) ||
          /^\s*>\s?/.test(lines[i]) ||
          /^\s*---\s*$/.test(lines[i])
        ) {
          break;
        }
        para.push(lines[i]);
        i += 1;
      }
      parsed.push({ type: "p", text: para.join("\n") });
    }

    return parsed;
  }, [content]);

  return (
    <div className="space-y-3 wrap-break-word">
      {blocks.map((block, idx) => {
        if (block.type === "heading") {
          const Tag =
            block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          const cls = headingClasses[block.level] || headingClasses[3];
          return (
            <Tag key={`h_${idx}`} className={cls}>
              {renderInlineMarkdown(block.text, inlineStyles)}
            </Tag>
          );
        }

        if (block.type === "ul") {
          return (
            <ul
              key={`ul_${idx}`}
              className={`list-disc space-y-1 pl-5 ${listClass}`}
            >
              {block.items.map((item, itemIdx) => (
                <li key={`uli_${idx}_${itemIdx}`}>
                  {renderInlineMarkdown(item, inlineStyles)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === "ol") {
          return (
            <ol
              key={`ol_${idx}`}
              className={`list-decimal space-y-1 pl-5 ${listClass}`}
            >
              {block.items.map((item, itemIdx) => (
                <li key={`oli_${idx}_${itemIdx}`}>
                  {renderInlineMarkdown(item, inlineStyles)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote
              key={`q_${idx}`}
              className={`border-l-2 ${quoteBorderClass} pl-3 ${quoteTextClass}`}
            >
              {block.text.split("\n").map((line, lineIdx, arr) => (
                <p key={`q_${idx}_${lineIdx}`}>
                  {renderInlineMarkdown(line, inlineStyles)}
                  {lineIdx < arr.length - 1 ? <br /> : null}
                </p>
              ))}
            </blockquote>
          );
        }

        if (block.type === "hr") {
          return <hr key={`hr_${idx}`} className={hrClass} />;
        }

        if (block.type === "table") {
          const tableClass = isUser
            ? "w-full text-sm border-collapse"
            : "w-full text-sm border-collapse";
          const thClass = isUser
            ? "text-left px-2 py-1.5 border-b border-zinc-300 font-medium text-black bg-zinc-100"
            : "text-left px-2 py-1.5 border-b border-zinc-700 font-medium text-zinc-100 bg-zinc-800/50";
          const tdClass = isUser
            ? "px-2 py-1.5 border-b border-zinc-200 text-black"
            : "px-2 py-1.5 border-b border-zinc-800 text-zinc-200";

          return (
            <div key={`table_${idx}`} className="overflow-x-auto -mx-1">
              <table className={tableClass}>
                <thead>
                  <tr>
                    {block.headers.map((header, hIdx) => (
                      <th key={`th_${idx}_${hIdx}`} className={thClass}>
                        {renderInlineMarkdown(header, inlineStyles)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={`tr_${idx}_${rIdx}`}>
                      {row.map((cell, cIdx) => (
                        <td
                          key={`td_${idx}_${rIdx}_${cIdx}`}
                          className={tdClass}
                        >
                          {renderInlineMarkdown(cell, inlineStyles)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        const lines = block.text.split("\n");
        return (
          <p key={`p_${idx}`} className={paragraphClass}>
            {lines.map((line, lineIdx) => (
              <span key={`p_${idx}_${lineIdx}`}>
                {renderInlineMarkdown(line, inlineStyles)}
                {lineIdx < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

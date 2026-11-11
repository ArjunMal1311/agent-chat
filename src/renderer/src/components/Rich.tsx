import { Fragment, type ReactNode } from "react";

// Message text becomes React nodes, never HTML, so it can never inject markup: code fences, `inline code`,
// **bold** and line breaks.
function inline(line: string, key: string): ReactNode[] {
  return line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code key={`${key}${i}`}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}${i}`}>{part.slice(2, -2)}</strong>;
    return <Fragment key={`${key}${i}`}>{part}</Fragment>;
  });
}

export function Rich({ text }: { text: string }) {
  return (
    <>
      {String(text)
        .split("```")
        .map((part, i) =>
          i % 2 === 1 ? (
            <pre key={i}>
              <code>{part.replace(/^\w*\n/, "")}</code>
            </pre>
          ) : (
            part.split("\n").map((line, j, all) => (
              <Fragment key={`${i}-${j}`}>
                {inline(line, `${i}-${j}-`)}
                {j < all.length - 1 ? <br /> : null}
              </Fragment>
            ))
          ),
        )}
    </>
  );
}

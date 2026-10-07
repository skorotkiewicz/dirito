import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";

function languageFor(path: string) {
  switch (path.split(".").at(-1)?.toLowerCase()) {
    case "js": case "mjs": case "cjs": return javascript();
    case "jsx": return javascript({ jsx: true });
    case "ts": case "mts": case "cts": return javascript({ typescript: true });
    case "tsx": return javascript({ typescript: true, jsx: true });
    case "html": case "htm": return html();
    case "css": return css();
    case "json": return json();
    case "md": case "markdown": return markdown();
    default: return [];
  }
}

const theme = EditorView.theme({
  "&": { height: "100%", color: "#e3e8df", backgroundColor: "#181c19" },
  "&.cm-focused": { outline: "2px solid #b7dc92", outlineOffset: "-2px" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "1.65" },
  ".cm-content": { padding: "16px 0", caretColor: "#b7dc92" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { backgroundColor: "#1c201d", color: "#939e96", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#263026" },
  ".cm-cursor": { borderLeftColor: "#b7dc92" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#3e5138" },
  ".cm-tooltip, .cm-panels": { backgroundColor: "#232a24", color: "#e3e8df", borderColor: "#535b51" },
}, { dark: true });
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "#e9bd7c" },
  { tag: [tags.string, tags.attributeValue], color: "#b7dc92" },
  { tag: [tags.number, tags.bool, tags.null], color: "#e6a699" },
  { tag: tags.comment, color: "#939e96", fontStyle: "italic" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "#8cc9c4" },
  { tag: [tags.attributeName, tags.propertyName, tags.function(tags.variableName)], color: "#ded795" },
  { tag: tags.heading, color: "#b7dc92", fontWeight: "bold" },
  { tag: tags.link, color: "#8cc9c4", textDecoration: "underline" },
]));

export function createEditorState(text: string, path: string, onUpdate: () => void = () => {}) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup, theme, highlighting, languageFor(path), keymap.of([indentWithTab]),
      EditorState.tabSize.of(2),
      EditorState.lineSeparator.of(text.match(/\r\n?|\n/)?.[0] ?? "\n"),
      EditorView.contentAttributes.of({ "aria-label": path ? `File contents: ${path}` : "File contents", spellcheck: "false" }),
      EditorView.updateListener.of(update => { if (update.docChanged || update.selectionSet) onUpdate(); }),
    ],
  });
}

import { test, expect } from "bun:test";
import { language, syntaxTree } from "@codemirror/language";
import { undoDepth } from "@codemirror/commands";
import { createEditorState } from "./editor";

test("editor selects parsers, preserves text, and resets undo history between files", () => {
  for (const [path, text, mode, node] of [
    ["app.js", "const answer = 42;", "javascript", "VariableDeclaration"],
    ["app.mjs", "export const answer = 42;", "javascript", "ExportDeclaration"],
    ["app.cjs", "module.exports = 42;", "javascript", "AssignmentExpression"],
    ["app.jsx", "const view = <div />;", "javascript", "JSXElement"],
    ["app.ts", "const answer: number = 42;", "typescript", "TypeAnnotation"],
    ["app.mts", "const answer: number = 42;", "typescript", "TypeAnnotation"],
    ["app.cts", "const answer: number = 42;", "typescript", "TypeAnnotation"],
    ["app.TSX", "const view = <div />;", "typescript", "JSXElement"],
    ["index.html", "<h1>Hello</h1>", "html", "TagName"],
    ["index.htm", "<h1>Hello</h1>", "html", "TagName"],
    ["style.css", "body { color: red; }", "css", "Declaration"],
    ["data.json", '{"answer": 42}', "json", "Property"],
    ["README.md", "# Hello", "markdown", "ATXHeading1"],
    ["README.markdown", "# Hello", "markdown", "ATXHeading1"],
  ] as const) {
    const state = createEditorState(text, path);
    expect(state.facet(language)?.name).toBe(mode);
    expect(syntaxTree(state).toString()).toContain(node);
    expect(state.sliceDoc()).toBe(text);
  }
  expect(createEditorState("hello", "notes.txt").facet(language)).toBeNull();
  for (const text of ["", "one\ntwo\n", "one\r\ntwo\r\n", "one\rtwo\r", "\ufeffconst café = '☕';\r\n"]) {
    const state = createEditorState(text, "app.js");
    expect(state.sliceDoc()).toBe(text);
    expect(state.update({ changes: { from: 0, insert: "// " } }).state.sliceDoc()).toBe("// " + text);
  }
  const edited = createEditorState("first", "first.txt").update({ changes: { from: 0, insert: "edit " } }).state;
  expect(undoDepth(edited)).toBe(1);
  expect(undoDepth(createEditorState("second", "second.txt"))).toBe(0);
});

import { test, expect } from "bun:test";
import { clampPaneSize } from "./resize";

test("pane resizing stays within its minimum and available space", () => {
  expect(clampPaneSize(240, 160, 800)).toBe(240);
  expect(clampPaneSize(-100, 160, 800)).toBe(160);
  expect(clampPaneSize(2000, 160, 800)).toBe(800);
  expect(clampPaneSize(160, 160, 160)).toBe(160);
  expect(clampPaneSize(100, 160, 120)).toBe(160);
});

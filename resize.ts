export const clampPaneSize = (size: number, min: number, max: number) => Math.max(min, Math.min(max, size));

export function resizePane(handle: HTMLElement, pane: HTMLElement) {
  const container = handle.parentElement!;
  const horizontal = handle.getAttribute("aria-orientation") === "horizontal";
  const dimension = horizontal ? "height" : "width";
  const minimum = horizontal ? "minHeight" : "minWidth";
  const direction = handle.nextElementSibling === pane ? -1 : 1;
  const size = (element: Element) => element.getBoundingClientRect()[dimension];
  const coordinate = (event: PointerEvent) => horizontal ? event.clientY : event.clientX;
  const bounds = () => {
    const min = parseFloat(getComputedStyle(pane)[minimum]) || 0;
    const otherMin = Array.from(container.children).filter(child => child !== pane && child !== handle)
      .reduce((sum, child) => sum + (parseFloat(getComputedStyle(child)[minimum]) || 0), 0);
    return { min, max: Math.max(min, size(container) - size(handle) - otherMin) };
  };
  const sync = () => {
    const { min, max } = bounds();
    const percent = (pixels: number) => String(Math.round(pixels / size(container) * 100));
    handle.setAttribute("aria-valuemin", percent(min));
    handle.setAttribute("aria-valuemax", percent(max));
    handle.setAttribute("aria-valuenow", percent(size(pane)));
    handle.setAttribute("aria-valuetext", `${Math.round(size(pane))} pixels`);
  };
  const apply = (pixels: number) => {
    const { min, max } = bounds();
    pane.style.setProperty("--pane-size", `${clampPaneSize(pixels, min, max) / size(container) * 100}%`);
    sync();
  };
  let drag: { coordinate: number; size: number; pointer: number } | undefined;
  handle.onpointerdown = event => {
    if (event.button !== 0 || document.body.classList.contains("resizing")) return;
    event.preventDefault(); handle.focus();
    drag = { coordinate: coordinate(event), size: size(pane), pointer: event.pointerId };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
  };
  handle.onpointermove = event => {
    if (drag && event.pointerId === drag.pointer) apply(drag.size + (coordinate(event) - drag.coordinate) * direction);
  };
  const finish = () => {
    if (!drag) return;
    const pointer = drag.pointer; drag = undefined;
    if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
    document.body.classList.remove("resizing"); document.body.style.cursor = "";
  };
  handle.onpointerup = finish;
  handle.onpointercancel = finish;
  handle.onlostpointercapture = finish;
  handle.onkeydown = event => {
    const delta = horizontal ? { ArrowUp: -10, ArrowDown: 10 } : { ArrowLeft: -10, ArrowRight: 10 };
    const { min, max } = bounds();
    if (event.key === "Home" || event.key === "End") apply(event.key === "Home" ? min : max);
    else if (event.key in delta) apply(size(pane) + delta[event.key as keyof typeof delta]! * direction * (event.shiftKey ? 4 : 1));
    else return;
    event.preventDefault();
  };
  new ResizeObserver(sync).observe(container);
  sync();
}

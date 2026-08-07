// A percentage height resolves only against a definite containing
// block, and definiteness is recursive (the parent may itself be a
// percentage of an auto-height ancestor) - so ask the layout engine
// with an in-flow probe: offsetHeight stays 0 exactly when the
// percentage fails to resolve. Every box property is pinned with
// inline !important declarations, which outrank any host stylesheet
// rule (including stylesheet !important), so page CSS matching the
// probe div (padding, borders, min-height, ...) cannot fake a definite
// verdict. flex:0 0 auto keeps a column flex parent from shrinking the
// probe. A definite height of exactly 0 still reads as indefinite -
// unavoidable with any measurement, and it routes a zero-sized
// (invisible) player to the stable branch. The synchronous
// append/measure/remove never reaches a rendering step, so a
// ResizeObserver does not see it.
const PROBE_STYLES = {
  position: "static",
  display: "block",
  "box-sizing": "border-box",
  height: "100%",
  width: "0",
  "min-height": "0",
  "max-height": "none",
  margin: "0",
  padding: "0",
  border: "none",
  flex: "0 0 auto",
  "align-self": "auto",
  transform: "none",
  visibility: "hidden",
};

export function probeParentHeightDefinite(parent) {
  const probe = document.createElement("div");
  for (const [prop, value] of Object.entries(PROBE_STYLES)) {
    probe.style.setProperty(prop, value, "important");
  }
  parent.appendChild(probe);
  const definite = probe.offsetHeight > 0;
  probe.remove();
  return definite;
}

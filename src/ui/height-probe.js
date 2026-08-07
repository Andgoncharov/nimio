// Answers the question the flicker guard actually depends on: does the
// output element's size feed back into the container's height? The
// rect-based fit oscillates exactly when it does (#86).
//
// Instead of inserting a synthetic element next to the container -
// which measures a proxy (the parent's definiteness) and is open to
// contamination through pseudo-element rules on empty children and
// structural selectors (:empty, :has, :nth-child) reacting to the
// temporary child - this flips the EXISTING output element's inline
// height between two extremes and checks whether the container's
// height follows. Nothing is inserted, so the DOM structure the host's
// selectors see never changes, and the verdict reflects the
// container's real computed height semantics: an unresolvable
// percentage, an auto-valued var(), or an inherited auto all read as
// content-sized no matter what the parent looks like.
//
// transition:none is pinned during the measurement so a host
// transition on the output cannot freeze the used height between the
// two reads. Inline styles are restored verbatim afterwards, and the
// synchronous flip never reaches a rendering step, so a ResizeObserver
// does not see it.
export function containerHeightIndependent(container, output) {
  const savedCss = output.style.cssText;
  output.style.setProperty("transition", "none", "important");
  output.style.setProperty("height", "1px", "important");
  const low = container.offsetHeight;
  output.style.setProperty("height", "99999px", "important");
  const high = container.offsetHeight;
  output.style.cssText = savedCss;
  return low === high;
}

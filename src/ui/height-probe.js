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
// Side-effect containment:
// - Measuring requires transition:none on the output, which would
//   cancel every CSS transition currently running there and snap it to
//   its end value. If one is running, the probe returns null instead
//   of measuring - the caller keeps its previous verdict, the
//   animation survives, and the resize events it produces re-run the
//   probe once it has finished.
// - transition:none stays pinned until one style change event has seen
//   the restored height, so re-enabling a host transition cannot
//   animate from the probe value (the before/after-change rule of the
//   CSS transitions model).
// - Ancestor scroll offsets - walking the composed tree through shadow
//   root hosts - are snapshotted first and re-applied last: the 1px
//   pass shrinks ancestor scroll ranges, and an engine may clamp
//   scrollTop during the forced layout and keep the clamped value
//   (Chromium restores it within the same task, but that is not
//   guaranteed elsewhere).
// - Restoration runs in a finally block, so styles and scroll come
//   back even if a measurement throws.
// - The synchronous flip never reaches a rendering step, so a
//   ResizeObserver does not see it, and inline styles are restored
//   verbatim.
export function containerHeightIndependent(container, output) {
  if (
    typeof output.getAnimations === "function" &&
    output
      .getAnimations()
      .some((a) => "transitionProperty" in a && a.playState === "running")
  ) {
    return null;
  }

  const savedCss = output.style.cssText;
  const savedScrolls = [];
  for (
    let node = container;
    node instanceof Element;
    node = node.parentElement ?? node.getRootNode().host ?? null
  ) {
    if (node.scrollTop || node.scrollLeft) {
      savedScrolls.push([node, node.scrollTop, node.scrollLeft]);
    }
  }

  let low, high;
  try {
    output.style.setProperty("transition", "none", "important");
    output.style.setProperty("height", "1px", "important");
    low = container.offsetHeight;
    output.style.setProperty("height", "99999px", "important");
    high = container.offsetHeight;
  } finally {
    output.style.cssText = savedCss;
    output.style.setProperty("transition", "none", "important");
    try {
      // Style change event with the steady height while transitions
      // are still off; the next event then sees no height difference.
      void output.offsetHeight;
    } catch {
      // measurement is best-effort during cleanup
    }
    output.style.cssText = savedCss;
    for (const [node, top, left] of savedScrolls) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
  }
  return low === high;
}

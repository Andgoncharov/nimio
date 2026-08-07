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
// - transition:none stays pinned until one style change event has seen
//   the restored height, so re-enabling a host transition cannot
//   animate from the probe value (the before/after-change rule of the
//   CSS transitions model). A host transition already running on the
//   output when the probe fires is necessarily cancelled and snaps to
//   its end value - unavoidable with any synchronous measurement.
// - Ancestor scroll offsets are snapshotted first and re-applied last:
//   the 1px pass shrinks ancestor scroll ranges, and an engine may
//   clamp scrollTop during the forced layout and keep the clamped
//   value (Chromium restores it within the same task, but that is not
//   guaranteed elsewhere).
// - The synchronous flip never reaches a rendering step, so a
//   ResizeObserver does not see it, and inline styles are restored
//   verbatim.
export function containerHeightIndependent(container, output) {
  const savedCss = output.style.cssText;
  const savedScrolls = [];
  for (let el = container; el; el = el.parentElement) {
    if (el.scrollTop || el.scrollLeft) {
      savedScrolls.push([el, el.scrollTop, el.scrollLeft]);
    }
  }

  output.style.setProperty("transition", "none", "important");
  output.style.setProperty("height", "1px", "important");
  const low = container.offsetHeight;
  output.style.setProperty("height", "99999px", "important");
  const high = container.offsetHeight;

  output.style.cssText = savedCss;
  output.style.setProperty("transition", "none", "important");
  // Style change event with the steady height while transitions are
  // still off; the next event then sees no height difference.
  void output.offsetHeight;
  output.style.cssText = savedCss;

  for (const [el, top, left] of savedScrolls) {
    el.scrollTop = top;
    el.scrollLeft = left;
  }
  return low === high;
}

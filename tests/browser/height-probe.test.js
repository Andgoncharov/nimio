import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { containerHeightIndependent } from "@/ui/height-probe";

// Exercises the production probe against a real layout engine. The
// probe flips the existing output element's inline height and checks
// whether the container's height follows - measuring the feedback
// loop itself, with no inserted element. That makes it immune to the
// vectors that broke element-insertion probes: pseudo-element rules on
// empty children, and structural selectors (:empty, :has, :nth-child)
// reacting to a temporary child.
const HOSTILE_CSS = `
  .hostile-pseudo > div:empty::before {
    content: "";
    display: block;
    height: 40px;
  }
  .hostile-has:has(> :nth-child(2)) {
    height: 300px;
  }
  .hostile-transition canvas {
    transition: height 1s linear;
  }
`;

describe("containerHeightIndependent", () => {
  let root;
  let styleTag;

  beforeEach(() => {
    styleTag = document.createElement("style");
    styleTag.textContent = HOSTILE_CSS;
    document.head.appendChild(styleTag);
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    styleTag.remove();
  });

  // Builds the production DOM shape: a parent (host page), the nimio
  // container with the configured css height inline, and a canvas
  // output inside it.
  function build({ parentCss, height, ancestorCss, parentClass, vars }) {
    let mount = root;
    if (ancestorCss !== undefined) {
      const ancestor = document.createElement("div");
      ancestor.style.cssText = ancestorCss;
      root.appendChild(ancestor);
      mount = ancestor;
    }
    const parent = document.createElement("div");
    parent.style.cssText = parentCss;
    if (parentClass) parent.className = parentClass;
    for (const [name, value] of Object.entries(vars ?? {})) {
      parent.style.setProperty(name, value);
    }
    mount.appendChild(parent);

    const container = document.createElement("div");
    Object.assign(container.style, {
      display: "block",
      position: "relative",
      width: "100%",
      height,
    });
    parent.appendChild(container);

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
    });
    container.appendChild(canvas);

    return { parent, container, canvas };
  }

  const CASES = [
    [
      "100% in a heightless block parent",
      { parentCss: "display:block", height: "100%" },
      false,
    ],
    [
      "100% in a 300px block parent",
      { parentCss: "display:block;height:300px", height: "100%" },
      true,
    ],
    [
      "100% of 100% of a heightless ancestor",
      {
        parentCss: "display:block;height:100%",
        ancestorCss: "display:block",
        height: "100%",
      },
      false,
    ],
    [
      "100% of 100% of a 300px ancestor",
      {
        parentCss: "display:block;height:100%",
        ancestorCss: "display:block;height:300px",
        height: "100%",
      },
      true,
    ],
    [
      "100% in a heightless flex row parent",
      { parentCss: "display:flex;flex-direction:row", height: "100%" },
      false,
    ],
    [
      "100% in a 300px flex row parent",
      {
        parentCss:
          "display:flex;flex-direction:row;height:300px;align-items:flex-start",
        height: "100%",
      },
      true,
    ],
    [
      "100% in a heightless flex column parent",
      { parentCss: "display:flex;flex-direction:column", height: "100%" },
      false,
    ],
    [
      "100% in a 300px flex column parent",
      {
        parentCss: "display:flex;flex-direction:column;height:300px",
        height: "100%",
      },
      true,
    ],
    [
      "100% in a heightless grid parent",
      { parentCss: "display:grid", height: "100%" },
      false,
    ],
    // An implicit auto row is stretched to the grid's 300px only while
    // the content fits; a larger output grows the row, so the feedback
    // loop is real and "content-sized" is the safe, correct verdict
    // (the old parent probe called this definite).
    [
      "100% in a 300px grid parent with an auto row",
      { parentCss: "display:grid;height:300px", height: "100%" },
      false,
    ],
    [
      "100% in a 300px grid parent with a definite row",
      {
        parentCss: "display:grid;height:300px;grid-template-rows:100%",
        height: "100%",
      },
      true,
    ],
    // Finding: var() must be judged by its resolved value, not by the
    // parent - an auto-valued variable in a definite parent is still
    // content-sized and would oscillate under the rect fit.
    [
      "var() resolving to auto in a 300px parent",
      {
        parentCss: "display:block;height:300px",
        height: "var(--player-height)",
        vars: { "--player-height": "auto" },
      },
      false,
    ],
    [
      "var() resolving to 480px in a heightless parent",
      {
        parentCss: "display:block",
        height: "var(--player-height)",
        vars: { "--player-height": "480px" },
      },
      true,
    ],
    [
      "var() resolving to 100% in a heightless parent",
      {
        parentCss: "display:block",
        height: "var(--player-height)",
        vars: { "--player-height": "100%" },
      },
      false,
    ],
    [
      "undefined var() in a 300px parent",
      {
        parentCss: "display:block;height:300px",
        height: "var(--player-height)",
      },
      false,
    ],
    [
      "inherit from a 300px parent",
      { parentCss: "display:block;height:300px", height: "inherit" },
      true,
    ],
    [
      "inherit from a heightless parent",
      { parentCss: "display:block", height: "inherit" },
      false,
    ],
    [
      "calc(100% - 40px) in a 300px parent",
      { parentCss: "display:block;height:300px", height: "calc(100% - 40px)" },
      true,
    ],
    [
      "calc(100% - 40px) in a heightless parent",
      { parentCss: "display:block", height: "calc(100% - 40px)" },
      false,
    ],
    // Finding: env() with a fallback can resolve to auto, and
    // calc-size(auto, ...) keeps intrinsic sizing - both must be
    // measured, not assumed definite. (If the browser rejects the
    // syntax the height falls back to auto, so the expected verdict
    // holds either way.)
    [
      "env() falling back to auto in a 300px parent",
      {
        parentCss: "display:block;height:300px",
        height: "env(missing-env-var, auto)",
      },
      false,
    ],
    [
      "calc-size(auto, size) in a 300px parent",
      {
        parentCss: "display:block;height:300px",
        height: "calc-size(auto, size)",
      },
      false,
    ],
    [
      "calc(50vh - 10px) in a heightless parent",
      { parentCss: "display:block", height: "calc(50vh - 10px)" },
      true,
    ],
    // Finding: pseudo-element rules on empty children fooled the
    // element-insertion probe; nothing is inserted now.
    [
      "hostile :empty::before rule, 100% in a heightless parent",
      {
        parentCss: "display:block",
        parentClass: "hostile-pseudo",
        height: "100%",
      },
      false,
    ],
    [
      "hostile :empty::before rule, 100% in a 300px parent",
      {
        parentCss: "display:block;height:300px",
        parentClass: "hostile-pseudo",
        height: "100%",
      },
      true,
    ],
    // Finding: a :has(> :nth-child(2)) rule gave the parent a height
    // only while a temporary child existed; the steady state (one
    // child) must decide.
    [
      "hostile :has(> :nth-child(2)) rule, 100% in a heightless parent",
      {
        parentCss: "display:block",
        parentClass: "hostile-has",
        height: "100%",
      },
      false,
    ],
    [
      "host transition on the output, 100% in a heightless parent",
      {
        parentCss: "display:block",
        parentClass: "hostile-transition",
        height: "100%",
      },
      false,
    ],
    // Improvement over the parent probe: a definite 0 is now
    // measurable - the container height stays 0 whatever the output
    // does, so the rect fit is safe.
    [
      "100% in a definite zero-height parent",
      { parentCss: "display:block;height:0", height: "100%" },
      true,
    ],
  ];

  for (const [name, setup, expected] of CASES) {
    it(`${name} -> ${expected ? "independent" : "content-sized"}`, () => {
      const { container, canvas } = build(setup);
      expect(containerHeightIndependent(container, canvas)).toBe(expected);
    });
  }

  it("does not mutate the DOM structure", () => {
    const { parent, container, canvas } = build({
      parentCss: "display:block;height:300px",
      height: "100%",
    });
    const parentChildren = parent.childNodes.length;
    const containerChildren = container.childNodes.length;

    containerHeightIndependent(container, canvas);

    expect(parent.childNodes.length).toBe(parentChildren);
    expect(container.childNodes.length).toBe(containerChildren);
  });

  it("restores the output's inline styles exactly", () => {
    const { container, canvas } = build({
      parentCss: "display:block;height:300px",
      height: "100%",
    });
    canvas.style.setProperty("height", "55%", "important");
    const before = canvas.style.cssText;

    containerHeightIndependent(container, canvas);

    expect(canvas.style.cssText).toBe(before);
  });

  it("does not start a host transition when restoring the output", async () => {
    // Finding: restoring cssText with a host height transition active
    // made the next style change animate from the 99999px probe value.
    const { container, canvas } = build({
      parentCss: "display:block",
      parentClass: "hostile-transition",
      height: "100%",
    });
    const steady = canvas.offsetHeight;
    let transitions = 0;
    canvas.addEventListener("transitionstart", () => transitions++);

    containerHeightIndependent(container, canvas);

    expect(canvas.offsetHeight).toBe(steady);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(transitions).toBe(0);
    expect(canvas.offsetHeight).toBe(steady);
  });

  it("preserves ancestor scroll positions", () => {
    // Finding: the 1px pass shrinks an overflowing ancestor's scroll
    // range, and the browser's scrollTop clamp survives restoration.
    const scroller = document.createElement("div");
    scroller.style.cssText = "height:200px;overflow:auto";
    const spacer = document.createElement("div");
    spacer.style.cssText = "height:300px";
    scroller.appendChild(spacer);
    root.appendChild(scroller);

    const parent = document.createElement("div");
    parent.style.cssText = "display:block;width:400px";
    scroller.appendChild(parent);
    const container = document.createElement("div");
    Object.assign(container.style, {
      display: "block",
      position: "relative",
      width: "100%",
      height: "100%",
    });
    parent.appendChild(container);
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    Object.assign(canvas.style, {
      display: "block",
      width: "100%",
      height: "225px",
    });
    container.appendChild(canvas);

    scroller.scrollTop = 250;
    expect(scroller.scrollTop).toBe(250);

    containerHeightIndependent(container, canvas);

    expect(scroller.scrollTop).toBe(250);
  });
});

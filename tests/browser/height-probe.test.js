import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { probeParentHeightDefinite } from "@/ui/height-probe";

// Exercises the production probe against a real layout engine - the
// definiteness verdict depends on CSS resolution that jsdom cannot
// compute. Hostile rules replicate host pages that style their
// wrapper's direct children, which contaminated the offsetHeight of an
// unstyled probe before it pinned its box properties with !important.
const HOSTILE_CSS = `
  .hostile > div {
    min-height: 40px;
    padding: 12px;
    border: 6px solid red;
  }
  .hostile-important > div {
    min-height: 40px !important;
    padding: 12px !important;
  }
`;

describe("probeParentHeightDefinite", () => {
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

  function makeParent({ parentCss, ancestorCss, parentClass, fillers = 1 }) {
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
    // Content stands in for the player container, so auto-height
    // parents are non-empty just like in production.
    for (let i = 0; i < fillers; i++) {
      const filler = document.createElement("div");
      filler.style.cssText = "height:80px;width:100px";
      parent.appendChild(filler);
    }
    mount.appendChild(parent);
    return parent;
  }

  const CASES = [
    ["block, no height", { parentCss: "display:block" }, false],
    ["block, height:300px", { parentCss: "display:block;height:300px" }, true],
    ["block, height:50vh", { parentCss: "display:block;height:50vh" }, true],
    [
      "block, height:100% of a heightless ancestor",
      { parentCss: "display:block;height:100%", ancestorCss: "display:block" },
      false,
    ],
    [
      "block, height:100% of a 300px ancestor",
      {
        parentCss: "display:block;height:100%",
        ancestorCss: "display:block;height:300px",
      },
      true,
    ],
    [
      "flex row, no height",
      { parentCss: "display:flex;flex-direction:row" },
      false,
    ],
    [
      "flex row, height:300px",
      { parentCss: "display:flex;flex-direction:row;height:300px" },
      true,
    ],
    [
      "flex column, no height",
      { parentCss: "display:flex;flex-direction:column" },
      false,
    ],
    [
      "flex column, height:300px",
      { parentCss: "display:flex;flex-direction:column;height:300px" },
      true,
    ],
    [
      "flex column, height:300px with shrink pressure",
      {
        parentCss: "display:flex;flex-direction:column;height:300px",
        fillers: 5,
      },
      true,
    ],
    ["grid, no height", { parentCss: "display:grid" }, false],
    ["grid, height:300px", { parentCss: "display:grid;height:300px" }, true],
    [
      "hostile child CSS, block, no height",
      { parentCss: "display:block", parentClass: "hostile" },
      false,
    ],
    [
      "hostile child CSS, block, height:300px",
      { parentCss: "display:block;height:300px", parentClass: "hostile" },
      true,
    ],
    [
      "hostile !important child CSS, block, no height",
      { parentCss: "display:block", parentClass: "hostile-important" },
      false,
    ],
    [
      "hostile child CSS, flex column, no height",
      {
        parentCss: "display:flex;flex-direction:column",
        parentClass: "hostile",
      },
      false,
    ],
    // Accepted degenerate: a definite 0 is indistinguishable from an
    // unresolved percentage by measurement; "indefinite" routes a
    // zero-sized (invisible) player to the stable branch.
    [
      "block, height:0 reads as indefinite",
      { parentCss: "display:block;height:0" },
      false,
    ],
  ];

  for (const [name, setup, expected] of CASES) {
    it(`${name} -> ${expected ? "definite" : "indefinite"}`, () => {
      expect(probeParentHeightDefinite(makeParent(setup))).toBe(expected);
    });
  }

  it("leaves no probe element behind", () => {
    const parent = makeParent({ parentCss: "display:block;height:300px" });
    const before = parent.childNodes.length;

    probeParentHeightDefinite(parent);

    expect(parent.childNodes.length).toBe(before);
  });
});

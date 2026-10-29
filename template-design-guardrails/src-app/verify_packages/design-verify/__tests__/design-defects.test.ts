//
// Unit tests for the pure rule logic of the dev-only runtime design-defect
// checker (src/designDefects.ts). The DOM walk, axe run, and
// layout-dependent measurements need a real browser (jsdom has no layout —
// scrollWidth is always 0 and there is no paint for contrast), so what lives
// here is the rule maths those measurements feed: the predicates and the
// heading-sequence rule. The live half is exercised by opening the app in
// dev mode, where the shell installs the checker when this package is present.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_HEIGHT_TOLERANCE_PX,
  CONTROL_TEXT_PX,
  FULL_BLEED_TOLERANCE_PX,
  MIN_CARD_PADDING_PX,
  SCROLL_EDGE_TOLERANCE_PX,
  TINY_TEXT_PX,
  axeResultsToFindings,
  clipInkToScrollers,
  collectHeadingSkipFindings,
  findCardEdgeFlush,
  findControlHeightMismatches,
  findHeadingSkips,
  findPageScrollers,
  installDesignDefectCheck,
  isClippedText,
  isFullBleedMedia,
  isSmallControlText,
  isTinyText,
  parseCssLengthPx,
  readTextFloors,
  runDesignDefectCheck,
  scrollsSideways,
  shareVisualRow,
  soleLayoutChild,
  spacingProbeSpec,
} from '../src/designDefects';
import type { LayoutRole } from '../src/designDefects';

// axe-core's run is stubbed per test: the sweep-failure test below (K-002)
// makes it reject to assert the rejection is caught, not left as an
// unhandled rejection, and the console tests hand it results.
const axeRun = vi.hoisted(() => vi.fn());
vi.mock('axe-core', () => ({
  default: {
    run: axeRun,
  },
}));

describe('text floors from the installed ramp', () => {
  it('resolves px and rem tokens against the root font size, else null', () => {
    expect(parseCssLengthPx('0.6875rem', 16)).toBeCloseTo(11);
    expect(parseCssLengthPx(' 13px ', 16)).toBe(13);
    expect(parseCssLengthPx('', 16)).toBeNull();
    expect(parseCssLengthPx('1.2em', 16)).toBeNull();
    expect(parseCssLengthPx('calc(1rem - 2px)', 16)).toBeNull();
  });

  it('reads the floors from :root tokens and falls back to the shipped values', () => {
    const root = document.documentElement;
    root.style.removeProperty('--text-mono-size');
    root.style.removeProperty('--text-label-size');
    expect(readTextFloors()).toEqual({ tinyTextPx: TINY_TEXT_PX, controlTextPx: CONTROL_TEXT_PX });

    root.style.setProperty('--text-mono-size', '12px');
    root.style.setProperty('--text-label-size', '0.875rem');
    root.style.fontSize = '16px';
    expect(readTextFloors()).toEqual({ tinyTextPx: 12, controlTextPx: 14 });
    root.style.removeProperty('--text-mono-size');
    root.style.removeProperty('--text-label-size');
    root.style.removeProperty('font-size');
  });

  it('isSmallControlText: below the label floor, zero ignored', () => {
    expect(isSmallControlText(CONTROL_TEXT_PX - 1)).toBe(true);
    expect(isSmallControlText(CONTROL_TEXT_PX)).toBe(false);
    expect(isSmallControlText(12, 14)).toBe(true);
    expect(isSmallControlText(0)).toBe(false);
  });
});

describe('isTinyText', () => {
  it('flags visible text below the floor and accepts the floor itself', () => {
    expect(isTinyText(TINY_TEXT_PX - 0.5)).toBe(true);
    expect(isTinyText(TINY_TEXT_PX)).toBe(false);
    expect(isTinyText(16)).toBe(false);
  });

  it('ignores zero — jsdom and detached elements report 0, not tiny text', () => {
    expect(isTinyText(0)).toBe(false);
  });
});

describe('isClippedText', () => {
  it('flags hidden/clip overflow wider than the box', () => {
    expect(isClippedText({ scrollWidth: 200, clientWidth: 100, clientHeight: 20, overflowX: 'hidden', textOverflow: 'clip' })).toBe(true);
    expect(isClippedText({ scrollWidth: 200, clientWidth: 100, clientHeight: 20, overflowX: 'clip', textOverflow: 'clip' })).toBe(true);
  });

  it('accepts ellipsis as an intentional truncation treatment', () => {
    expect(isClippedText({ scrollWidth: 200, clientWidth: 100, clientHeight: 20, overflowX: 'hidden', textOverflow: 'ellipsis' })).toBe(false);
  });

  it('accepts scrollable and visible overflow', () => {
    expect(isClippedText({ scrollWidth: 200, clientWidth: 100, clientHeight: 20, overflowX: 'auto', textOverflow: 'clip' })).toBe(false);
    expect(isClippedText({ scrollWidth: 200, clientWidth: 100, clientHeight: 20, overflowX: 'visible', textOverflow: 'clip' })).toBe(false);
  });

  it('exempts the screen-reader-only pattern (content clipped in a ~1px box)', () => {
    expect(isClippedText({ scrollWidth: 51, clientWidth: 1, clientHeight: 1, overflowX: 'hidden', textOverflow: 'clip' })).toBe(false);
  });

  it('tolerates sub-pixel rounding', () => {
    expect(isClippedText({ scrollWidth: 101, clientWidth: 100, clientHeight: 20, overflowX: 'hidden', textOverflow: 'clip' })).toBe(false);
  });
});

describe('scrollsSideways', () => {
  it('flags a scroll container whose content is wider than its box', () => {
    // The shell's screen container holding a 900px screen at a 320px viewport.
    expect(scrollsSideways({ overflowX: 'auto', scrollWidth: 900, clientWidth: 288 })).toBe(true);
    expect(scrollsSideways({ overflowX: 'scroll', scrollWidth: 900, clientWidth: 288 })).toBe(true);
  });

  it('accepts content that fits, within sub-pixel rounding', () => {
    expect(scrollsSideways({ overflowX: 'auto', scrollWidth: 288, clientWidth: 288 })).toBe(false);
    expect(scrollsSideways({ overflowX: 'auto', scrollWidth: 289, clientWidth: 288 })).toBe(false);
  });

  it('ignores boxes that clip or let content spill instead of scrolling', () => {
    expect(scrollsSideways({ overflowX: 'hidden', scrollWidth: 900, clientWidth: 288 })).toBe(false);
    expect(scrollsSideways({ overflowX: 'clip', scrollWidth: 900, clientWidth: 288 })).toBe(false);
    expect(scrollsSideways({ overflowX: 'visible', scrollWidth: 900, clientWidth: 288 })).toBe(false);
  });
});

describe('findPageScrollers', () => {
  interface Box {
    name: string;
    scroller: boolean;
    grid: boolean;
    parent: Box | null;
    children: Box[];
  }

  function box(name: string, scroller: boolean, children: Box[] = []): Box {
    const node: Box = { name, scroller, grid: false, parent: null, children };
    for (const child of children) child.parent = node;
    return node;
  }

  function grid(name: string): Box {
    return { ...box(name, false), grid: true };
  }

  const tree = {
    parent: (node: Box) => node.parent,
    soleChild: (node: Box) => (node.children.length === 1 ? node.children[0] : null),
    isScroller: (node: Box) => node.scroller,
    isGrid: (node: Box) => node.grid,
  };

  function scrollersFrom(main: Box): string[] {
    return findPageScrollers(main, tree).map((node) => node.name);
  }

  it("finds the shell's screen container below a main that does not scroll", () => {
    // Layout > main (overflow hidden) > div[data-mfe-screen-container] (overflow auto) > slot > screen
    const main = box('main', false, [box('screen-container', true, [box('slot', false, [box('screen', false)])])]);
    box('layout', false, [main]);

    expect(scrollersFrom(main)).toEqual(['screen-container']);
  });

  it('measures every scroller on the sole-child chain, so a screen that scrolls on its own is found too', () => {
    const main = box('main', false, [box('screen-container', true, [box('slot', false, [box('screen-root', true)])])]);

    expect(scrollersFrom(main)).toEqual(['screen-container', 'screen-root']);
  });

  it("stops at a scroller whose only child is a table or grid: that is the grid's own scroll, not the page's", () => {
    // The screen's only content is a data grid in its own overflow-x: auto wrapper.
    const main = box('main', false, [
      box('screen-container', true, [box('slot', false, [box('table-wrapper', true, [grid('table')])])]),
    ]);

    expect(scrollersFrom(main)).toEqual(['screen-container']);
  });

  it('still measures the page container when a grid is all the screen holds and has no scroll box of its own', () => {
    const main = box('main', false, [box('screen-container', true, [box('slot', false, [grid('table')])])]);

    expect(scrollersFrom(main)).toEqual(['screen-container']);
  });

  it('stops at a level with more than one child, so a table in its own scroll wrapper is not the page', () => {
    const main = box('main', false, [box('screen', false, [box('heading', false), box('table-wrapper', true)])]);

    expect(scrollersFrom(main)).toEqual([]);
  });

  it('includes the main landmark itself and the scrollers above it, nearest first', () => {
    const main = box('main', true, [box('screen', false)]);
    box('app', true, [box('frame', false, [main])]);

    expect(scrollersFrom(main)).toEqual(['app', 'main']);
  });

  it('returns nothing when no box on the way scrolls', () => {
    const main = box('main', false, [box('screen', false)]);
    box('layout', false, [main]);

    expect(scrollersFrom(main)).toEqual([]);
  });
});

describe('soleLayoutChild', () => {
  interface LayoutNode {
    name: string;
    role: LayoutRole;
    contents: LayoutNode[];
  }

  const node = (name: string, role: LayoutRole, contents: LayoutNode[] = []): LayoutNode => ({ name, role, contents });
  const layout = { role: (n: LayoutNode) => n.role, contents: (n: LayoutNode) => n.contents };
  const sole = (nodes: LayoutNode[]) => soleLayoutChild(nodes, layout)?.name ?? null;

  it('returns the only box, passing over nodes that take no part in the layout', () => {
    // Whitespace text, a hidden element, a positioned badge.
    expect(sole([node('ws', 'none'), node('screen', 'box'), node('badge', 'none')])).toBe('screen');
  });

  it('returns null for a level with more than one box, or text beside a box', () => {
    expect(sole([node('heading', 'box'), node('table-wrapper', 'box')])).toBeNull();
    expect(sole([node('label', 'text'), node('screen', 'box')])).toBeNull();
    expect(sole([node('ws', 'none')])).toBeNull();
  });

  it("counts the boxes inside a display: contents wrapper, so a sibling is not taken for the level's only child", () => {
    // The screen's heading and copy sit in a wrapper without a box of its
    // own, beside a table that scrolls in its own wrapper.
    const wrapper = node('wrapper', 'contents', [node('heading', 'box'), node('copy', 'box')]);

    expect(sole([wrapper, node('table-wrapper', 'box')])).toBeNull();
  });

  it('follows a display: contents wrapper (a slot, by default) to the only box it lays out', () => {
    const slot = node('slot', 'contents', [node('ws', 'none'), node('screen-root', 'box')]);

    expect(sole([slot])).toBe('screen-root');
    expect(sole([node('outer', 'contents', [node('inner', 'contents', [node('screen-root', 'box')])])])).toBe(
      'screen-root'
    );
  });

  it('returns null when a wrapper lays out text beside the box', () => {
    expect(sole([node('wrapper', 'contents', [node('label', 'text')]), node('screen', 'box')])).toBeNull();
  });
});

describe('shareVisualRow', () => {
  it('bottom-aligned controls of different heights still share the row', () => {
    // items-end row: 40px input and 36px button, flush bottoms.
    expect(shareVisualRow(
      { top: 0, bottom: 40, height: 40 },
      { top: 4, bottom: 40, height: 36 }
    )).toBe(true);
  });

  it('controls stacked in separate rows do not', () => {
    expect(shareVisualRow(
      { top: 0, bottom: 40, height: 40 },
      { top: 56, bottom: 92, height: 36 }
    )).toBe(false);
  });

  it('a zero-height box never shares a row', () => {
    expect(shareVisualRow(
      { top: 0, bottom: 40, height: 40 },
      { top: 10, bottom: 10, height: 0 }
    )).toBe(false);
  });
});

describe('findControlHeightMismatches', () => {
  it('flags a default-size button beside a large input (the 36px-vs-40px case)', () => {
    expect(findControlHeightMismatches([
      { top: 0, bottom: 40, height: 40 },
      { top: 4, bottom: 40, height: 36 },
    ])).toEqual([{ a: 0, b: 1 }]);
  });

  it('accepts matched heights and tolerates border-box rounding', () => {
    expect(findControlHeightMismatches([
      { top: 0, bottom: 40, height: 40 },
      { top: 0, bottom: 40, height: 40 },
    ])).toEqual([]);
    expect(findControlHeightMismatches([
      { top: 0, bottom: 40, height: 40 },
      { top: 1, bottom: 40, height: 40 - CONTROL_HEIGHT_TOLERANCE_PX },
    ])).toEqual([]);
  });

  it('ignores controls the flex container has wrapped onto another line', () => {
    expect(findControlHeightMismatches([
      { top: 0, bottom: 40, height: 40 },
      { top: 48, bottom: 84, height: 36 },
    ])).toEqual([]);
  });
});

describe('clipInkToScrollers', () => {
  it('cuts both sides of wide ink and keeps an edge that starts at padded content', () => {
    const box = { left: 112, right: 388 };
    expect(clipInkToScrollers({ left: 100, right: 420 }, [box])).toEqual({ left: null, right: null });
    expect(clipInkToScrollers({ left: 112, right: 420 }, [box])).toEqual({ left: 112, right: null });
  });

  it('keeps an unpadded left edge measurable while cutting the right side', () => {
    const ink = clipInkToScrollers({ left: 100, right: 420 }, [{ left: 100, right: 400 }]);
    expect(ink).toEqual({ left: 100, right: null });
    expect(findCardEdgeFlush({ left: 100, right: 400 }, [ink!], { left: true, right: true })).toEqual([
      { side: 'left', insetPx: 0 },
    ]);
  });

  it('cuts only the side beyond a scroller and drops ink fully out of view', () => {
    const box = { left: 112, right: 388 };
    expect(clipInkToScrollers({ left: 100, right: 388 }, [box])).toEqual({ left: null, right: 388 });
    expect(clipInkToScrollers({ left: 390, right: 420 }, [box])).toBeNull();
  });

  it('intersects nested scrollers regardless of order', () => {
    const outer = { left: 108, right: 390 };
    const inner = { left: 112, right: 400 };
    expect(clipInkToScrollers({ left: 110, right: 395 }, [outer, inner])).toEqual({ left: null, right: null });
    expect(clipInkToScrollers({ left: 110, right: 395 }, [inner, outer])).toEqual({ left: null, right: null });
  });

  it('leaves ink unclipped without a scroller, so overflow past a hidden or clip container is still reported', () => {
    const ink = clipInkToScrollers({ left: 90, right: 380 }, []);
    expect(ink).toEqual({ left: 90, right: 380 });
    expect(findCardEdgeFlush({ left: 100, right: 400 }, [ink!], { left: true, right: true })).toEqual([
      { side: 'left', insetPx: -10 },
    ]);
  });

  it('cuts by the element box, so cell text short of the edge in a cut cell is not measured', () => {
    const scroller = { left: 100, right: 400 };
    const cellText = { left: 316, right: 399 };
    const cell = { left: 300, right: 415 };
    expect(clipInkToScrollers(cellText, [scroller], cell)).toEqual({ left: 316, right: null });
    expect(clipInkToScrollers(cellText, [scroller])).toEqual({ left: 316, right: 399 });
    expect(clipInkToScrollers({ left: 408, right: 412 }, [scroller], { left: 405, right: 415 })).toBeNull();
  });

  it('does not cut a child that fills the scroller to within a subpixel', () => {
    const box = { left: 112, right: 388 };
    const edge = SCROLL_EDGE_TOLERANCE_PX / 2;
    expect(clipInkToScrollers({ left: 112 - edge, right: 388 + edge }, [box])).toEqual({
      left: 112 - edge,
      right: 388 + edge,
    });
  });

  it('accepts padded ink at both scroll ends', () => {
    const content = { left: 100, right: 400 };
    const box = { left: content.left + MIN_CARD_PADDING_PX, right: content.right - MIN_CARD_PADDING_PX };
    const start = clipInkToScrollers({ left: box.left, right: 450 }, [box]);
    const end = clipInkToScrollers({ left: 50, right: box.right }, [box]);
    expect(start).toEqual({ left: box.left, right: null });
    expect(end).toEqual({ left: null, right: box.right });
    expect(findCardEdgeFlush(content, [start!, end!], { left: true, right: true })).toEqual([]);
  });
});

describe('findCardEdgeFlush', () => {
  const content = { left: 100, right: 400 };
  const bothSides = { left: true, right: true };

  it('flags ink flush against a drawn edge (the unpadded task-row case)', () => {
    expect(findCardEdgeFlush(content, [{ left: 100, right: 380 }], bothSides)).toEqual([
      { side: 'left', insetPx: 0 },
    ]);
  });

  it('accepts ink at or beyond the minimum padding on every drawn side', () => {
    expect(
      findCardEdgeFlush(content, [{ left: 100 + MIN_CARD_PADDING_PX, right: 400 - MIN_CARD_PADDING_PX }], bothSides)
    ).toEqual([]);
  });

  it('judges only the sides the card actually draws (divided list rows draw none)', () => {
    expect(findCardEdgeFlush(content, [{ left: 100, right: 400 }], { left: false, right: false })).toEqual([]);
    expect(findCardEdgeFlush(content, [{ left: 100, right: 400 }], { left: false, right: true })).toEqual([
      { side: 'right', insetPx: 0 },
    ]);
  });

  it('measures the closest ink per side across all content', () => {
    expect(
      findCardEdgeFlush(
        content,
        [
          { left: 116, right: 200 },
          { left: 101, right: 390 },
        ],
        bothSides
      )
    ).toEqual([{ side: 'left', insetPx: 1 }]);
  });

  it('reports nothing for an empty card', () => {
    expect(findCardEdgeFlush(content, [], bothSides)).toEqual([]);
  });

  it('skips null sides and leaves a side with only null values unmeasured', () => {
    expect(findCardEdgeFlush(content, [{ left: null, right: 400 }, { left: 116, right: null }], bothSides)).toEqual([
      { side: 'right', insetPx: 0 },
    ]);
    expect(findCardEdgeFlush(content, [{ left: null, right: 400 }], bothSides)).toEqual([
      { side: 'right', insetPx: 0 },
    ]);
    expect(findCardEdgeFlush(content, [{ left: null, right: null }], bothSides)).toEqual([]);
  });
});

describe('isFullBleedMedia', () => {
  it('exempts media filling the card, within tolerance', () => {
    expect(isFullBleedMedia(300, 300)).toBe(true);
    expect(isFullBleedMedia(300, 300 - FULL_BLEED_TOLERANCE_PX)).toBe(true);
    expect(isFullBleedMedia(300, 280)).toBe(false);
    expect(isFullBleedMedia(0, 0)).toBe(false);
  });
});

describe('spacingProbeSpec', () => {
  it('maps padding and margin utilities to the sides they must move', () => {
    expect(spacingProbeSpec('p-8')).toEqual({ kind: 'self', properties: ['padding-top'] });
    expect(spacingProbeSpec('px-4')).toEqual({
      kind: 'self',
      properties: ['padding-left', 'padding-right'],
    });
    expect(spacingProbeSpec('ps-2')).toEqual({ kind: 'self', properties: ['padding-inline-start'] });
    expect(spacingProbeSpec('mt-1.5')).toEqual({ kind: 'self', properties: ['margin-top'] });
    expect(spacingProbeSpec('-m-4')).toEqual({ kind: 'self', properties: ['margin-top'] });
    expect(spacingProbeSpec('p-px')).toEqual({ kind: 'self', properties: ['padding-top'] });
  });

  it('maps gap and space-between utilities, space landing on a sibling', () => {
    expect(spacingProbeSpec('gap-4')).toEqual({ kind: 'self', properties: ['row-gap'] });
    expect(spacingProbeSpec('gap-x-2')).toEqual({ kind: 'self', properties: ['column-gap'] });
    expect(spacingProbeSpec('space-y-3')).toEqual({
      kind: 'sibling',
      properties: ['margin-top', 'margin-bottom'],
    });
  });

  it('ignores zero suffixes, variants, arbitrary values, and non-spacing classes', () => {
    expect(spacingProbeSpec('p-0')).toBeNull();
    expect(spacingProbeSpec('gap-0')).toBeNull();
    expect(spacingProbeSpec('md:p-8')).toBeNull();
    expect(spacingProbeSpec('p-[13px]')).toBeNull();
    expect(spacingProbeSpec('font-bold')).toBeNull();
    expect(spacingProbeSpec('padding')).toBeNull();
  });
});

describe('findHeadingSkips', () => {
  it('flags a level jump and names both sides', () => {
    expect(findHeadingSkips([1, 3])).toEqual([{ from: 1, to: 3 }]);
    expect(findHeadingSkips([2, 2, 4, 5])).toEqual([{ from: 2, to: 4 }]);
  });

  it('accepts descending and stepwise sequences', () => {
    expect(findHeadingSkips([1, 2, 3, 2, 3])).toEqual([]);
    expect(findHeadingSkips([3, 1, 2])).toEqual([]);
  });

  it('lets the first heading start at any level — screens inside a host begin below h1', () => {
    expect(findHeadingSkips([3])).toEqual([]);
    expect(findHeadingSkips([])).toEqual([]);
  });
});

describe('collectHeadingSkipFindings', () => {
  it('pairs each skip with the heading that caused it, not the first heading of that level', () => {
    // Levels [1, 3, 1, 3]: two independent skips (h1->h3 at index 1, h1->h3
    // at index 3), each must target its own h3 element, not both resolving
    // to the first one.
    const h3a = document.createElement('h3');
    h3a.id = 'first-h3';
    const h3b = document.createElement('h3');
    h3b.id = 'second-h3';
    const headingEls = [document.createElement('h1'), h3a, document.createElement('h1'), h3b];
    const headingLevels = [1, 3, 1, 3];

    const findings = collectHeadingSkipFindings(headingLevels, headingEls);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ id: 'skipped-heading', detail: 'heading level jumps h1 → h3', target: 'h3#first-h3' });
    expect(findings[1]).toMatchObject({ id: 'skipped-heading', detail: 'heading level jumps h1 → h3', target: 'h3#second-h3' });
    expect(findings[0].target).not.toBe(findings[1].target);
  });
});

describe('installDesignDefectCheck sweep failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__frontxDesignDefects;
  });

  it('catches a rejected sweep instead of leaving an unhandled rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    axeRun.mockRejectedValueOnce(new Error('axe-core failed to run'));

    installDesignDefectCheck(0);
    // Real timers: let the scheduled sweep (and the mocked axe-core
    // rejection it awaits) settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errorSpy).toHaveBeenCalledWith('[design-defects] sweep failed:', expect.any(Error));
  });
});

describe('axeResultsToFindings', () => {
  // Only the fields the mapping reads; axe's own result objects carry more.
  function result(id: string, nodes: Array<{ target: string[]; messages: string[] }>, extra: Record<string, unknown> = {}) {
    return {
      id,
      help: `${id} help`,
      impact: 'serious',
      nodes: nodes.map((node) => ({
        target: node.target,
        any: node.messages.map((message) => ({ id: 'check', message })),
        all: [],
        none: [],
      })),
      ...extra,
    };
  }

  function map(violations: unknown[], incomplete: unknown[]) {
    return axeResultsToFindings({ violations, incomplete } as unknown as Parameters<typeof axeResultsToFindings>[0]);
  }

  it('maps each violation to a defect, as before', () => {
    expect(map([result('color-contrast', [{ target: ['p'], messages: ['2.32:1'] }, { target: ['span'], messages: [] }])], [])).toEqual([
      {
        id: 'axe/color-contrast',
        detail: 'color-contrast help (impact: serious, 2 node(s))',
        target: 'p',
      },
    ]);
  });

  it('reports each node axe could not decide the contrast of as needing review, with its own target and reasons', () => {
    const gradient = "Element's background color could not be determined due to a background gradient";
    const overlapped = "Element's background color could not be determined because it's overlapped by another element";
    const findings = map(
      [],
      [
        result('color-contrast', [
          { target: ['p.synced'], messages: [gradient] },
          { target: ['span.hint'], messages: [gradient, gradient] },
          { target: ['em'], messages: [overlapped, gradient] },
        ]),
      ]
    );

    expect(findings).toEqual([
      { id: 'axe-incomplete/color-contrast', detail: `axe could not decide this: ${gradient}`, target: 'p.synced', kind: 'needs-review' },
      { id: 'axe-incomplete/color-contrast', detail: `axe could not decide this: ${gradient}`, target: 'span.hint', kind: 'needs-review' },
      {
        id: 'axe-incomplete/color-contrast',
        detail: `axe could not decide this: ${overlapped}; ${gradient}`,
        target: 'em',
        kind: 'needs-review',
      },
    ]);
  });

  it("leaves out other rules' undecided results and empty ones", () => {
    expect(map([], [result('aria-valid-attr-value', [{ target: ['div'], messages: ['?'] }]), result('color-contrast', [])])).toEqual([]);
  });
});

describe('runDesignDefectCheck console output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the clean line only when nothing was found and nothing is undecided', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    axeRun.mockResolvedValueOnce({ violations: [], incomplete: [] });

    expect(await runDesignDefectCheck()).toEqual([]);
    expect(info).toHaveBeenCalledWith('[design-defects] clean: no objective design defects detected');
  });

  it('lists undecided contrast as needing review instead of printing the clean line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    axeRun.mockResolvedValueOnce({
      violations: [],
      incomplete: [
        {
          id: 'color-contrast',
          help: 'h',
          nodes: [{ target: ['p.synced'], any: [{ message: 'background gradient' }], all: [], none: [] }],
        },
      ],
    });

    const findings = await runDesignDefectCheck();

    expect(findings).toEqual([expect.objectContaining({ id: 'axe-incomplete/color-contrast', kind: 'needs-review' })]);
    // Both kinds in full: axe keeps one node per result for a type left out.
    expect(axeRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resultTypes: ['violations', 'incomplete'] }),
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      '[design-defects] 1 item(s) need review — undecided, so this state is not clean:',
      '[design-defects] needs review axe-incomplete/color-contrast: axe could not decide this: background gradient — p.synced',
    ]);
  });
});

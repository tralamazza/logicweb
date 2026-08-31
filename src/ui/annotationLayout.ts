/**
 * Annotation bubble layout - the part that is easy to get wrong.
 *
 * [CHOSEN] transcribed:
 *
 *   - each frame supplies several candidate strings, longest to shortest; pick the longest
 *     that fits and fall back to the shortest, so a label degrades from
 *     "Setup Write to [0xA0] + ACK" down to "A0" instead of being clipped or hidden;
 *   - frames narrower than legibility merge into a MultiBubble carrying a count badge that
 *     saturates at 99+; the badge is a 9 px, 2 px-padded, 5 px-radius chip in
 *     background-30;
 *   - a bubble extending past the viewport edge is clamped to the viewport so its text
 *     stays readable, and grows a 3 px solid triangle on the overflowing side;
 *   - bubbles fully off-screen return null early.
 *
 * The one deliberate difference from the obvious approach: picking a variant with `text.length * 6 < bubbleWidth`
 * (CHAR_WIDTH = 6 at font-size 14). We measure the string with the same canvas context that
 * will draw it. That is the same rule evaluated exactly instead of by a per-character
 * average, so a wide string is never chosen and then clipped and a narrow one is never
 * rejected when it would have fitted.
 */

import { BUBBLE } from './metrics.js';

export interface AnnotationSpan {
  /** Sample coordinates. */
  start: number;
  end: number;
  /** Text variants, longest first, as sigrok emits them. */
  texts: readonly string[];
}

export interface Bubble {
  /** CSS px in the plot area, already clamped to the viewport. */
  x0: number;
  x1: number;
  text: string;
  /** >1 for a merged multi-bubble. */
  count: number;
  /** "99+" once the count saturates. */
  badge: string | null;
  overflowLeft: boolean;
  overflowRight: boolean;
  /** For the tooltip, capped at BUBBLE.tooltipChars. */
  title: string;
}

export interface LayoutInput {
  spans: readonly AnnotationSpan[];
  /** sample -> CSS px inside the plot area. */
  toPx: (sample: number) => number;
  widthCss: number;
  /** A 2D context whose font is already BUBBLE.font. Used only for measureText. */
  measure: CanvasRenderingContext2D;
}

export function layoutBubbles(input: LayoutInput): Bubble[] {
  const { spans, toPx, widthCss, measure } = input;
  const placed: { x0: number; x1: number; span: AnnotationSpan }[] = [];
  for (const s of spans) {
    const x0 = toPx(s.start);
    const x1 = toPx(s.end);
    // [SOURCE] fully off-screen returns null early - a real optimisation during a fast pan.
    if (x1 < 0 || x0 > widthCss) continue;
    placed.push({ x0, x1, span: s });
  }
  placed.sort((a, b) => a.x0 - b.x0);

  const out: Bubble[] = [];
  let i = 0;
  while (i < placed.length) {
    const first = placed[i]!;
    let j = i + 1;
    let x0 = first.x0;
    let x1 = first.x1;
    // Merge while the average width of the group is below legibility. Using the average
    // rather than each frame's own width is what stops a single wide frame in a dense run
    // from splitting the run into three bubbles.
    while (
      j < placed.length &&
      (Math.max(x1, placed[j]!.x1) - x0) / (j - i + 1) < BUBBLE.minLegibleWidth
    ) {
      x1 = Math.max(x1, placed[j]!.x1);
      j++;
    }
    const count = j - i;
    const group = placed.slice(i, j);
    out.push(makeBubble(group, x0, x1, count, widthCss, measure));
    i = j;
  }
  return out;
}

function makeBubble(
  group: { x0: number; x1: number; span: AnnotationSpan }[],
  x0: number,
  x1: number,
  count: number,
  widthCss: number,
  measure: CanvasRenderingContext2D,
): Bubble {
  const overflowLeft = x0 < 0;
  const overflowRight = x1 > widthCss;
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(widthCss, x1);

  const badge = count > 1
    ? (count > BUBBLE.maxCount ? `${BUBBLE.maxCount}+` : String(count))
    : null;
  const badgeW = badge ? measure.measureText(badge).width + 2 * BUBBLE.badgePad + 4 : 0;
  const room = Math.max(0, cx1 - cx0 - 2 * BUBBLE.padX - badgeW);

  let text = '';
  if (count === 1) {
    // [SOURCE] longest that fits, else the shortest.
    const variants = group[0]!.span.texts;
    text = variants.length ? variants[variants.length - 1]! : '';
    for (const v of variants) {
      if (measure.measureText(v).width <= room) { text = v; break; }
    }
    if (variants.length && measure.measureText(text).width > room) text = '';
  } else {
    // A multi-bubble shows its badge and then as many of the merged short forms as fit -
    // which is what 02-capture-in-progress.png shows: "99+ 0x08 0x09 0x0A ...".
    const parts: string[] = [];
    let used = 0;
    for (const g of group) {
      const v = g.span.texts.length ? g.span.texts[g.span.texts.length - 1]! : '';
      if (!v) continue;
      const w = measure.measureText(`${v} `).width;
      if (used + w > room) break;
      parts.push(v);
      used += w;
    }
    text = parts.join(' ');
  }

  const full = count > 1
    ? `[${count} results] ${group.map((g) => g.span.texts[0] ?? '').join(', ')}`
    : (group[0]!.span.texts[0] ?? '');

  return {
    x0: cx0,
    x1: cx1,
    text,
    count,
    badge,
    overflowLeft,
    overflowRight,
    title: full.length > BUBBLE.tooltipChars ? `${full.slice(0, BUBBLE.tooltipChars - 1)}…` : full,
  };
}

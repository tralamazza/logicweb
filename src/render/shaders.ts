// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * GLSL ES 3.00 for the digital waveform.
 *
 * One instanced quad per channel row. The fragment shader is where all the decisions
 * live, and they are a direct transcription of what a Canvas 2D renderer does
 * per pixel column:
 *
 *   ALWAYS_HIGH             -> a 1 CSS px line at the top of the trace band
 *   ALWAYS_LOW              -> a 1 CSS px line at the bottom of the trace band
 *   ONE_OR_MORE_TRANSITIONS -> a solid bar spanning the FULL trace height
 *   NO_DATA                 -> 4% alpha wash over the row + a 2 px top border at 20%
 *
 * NO_DATA has two sources: no column overlaps the viewport (past the end of the capture),
 * and bit3 of a column byte (the store knows that span is missing - a capture gap). Both
 * draw the same wash, and a gap column never lets a neighbour's transition bar extend
 * into it.
 *
 * Two deliberate choices, both documented in NOTES.md:
 *
 * 1. Coverage is computed analytically instead of being handed to `fillRect`. All the
 *    geometry is snapped to whole device pixels on the CPU, so coverage comes out exactly
 *    0 or 1 and the result is bit-identical to a crisp non-antialiased draw. When the
 *    geometry is NOT integral (fractional devicePixelRatio, a hand-set line width) it
 *    degrades to correct area coverage instead of Canvas 2D's fractional-rect blur.
 * 2. The transition bar is extended by half a line width at each end so it meets the
 *    idle lines exactly. Drawing it gutter to gutter would leave the idle
 *    line poking out by half a pixel.
 *
 * There is no per-sample geometry anywhere: the whole frame is `rows` quads, and the
 * cost is O(pixels), not O(samples). That is the same decision as any per-pixel-
 * column classification, taken for the same reason.
 */

export const MAX_ROWS = 16;

export const VERTEX_SRC = `#version 300 es
precision highp float;

uniform vec2  u_canvas;               // device px
uniform float u_rowTop[${MAX_ROWS}];  // device px, top-down
uniform float u_rowH[${MAX_ROWS}];

flat out int v_row;

void main() {
  // Two triangles from gl_VertexID alone; no buffers, no attribute state to get wrong.
  int id = gl_VertexID;
  float fx = float(id & 1);
  float fy = float((id >> 1) & 1);
  int r = gl_InstanceID;
  float x = fx * u_canvas.x;
  float y = u_rowTop[r] + fy * u_rowH[r];
  v_row = r;
  gl_Position = vec4(x / u_canvas.x * 2.0 - 1.0, 1.0 - y / u_canvas.y * 2.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_cols;
uniform vec2  u_canvas;
uniform vec2  u_map;                  // screenX = column * u_map.x + u_map.y
uniform int   u_dataBins;             // 0 => nothing in the store overlaps the view
uniform float u_rowTop[${MAX_ROWS}];
uniform float u_rowH[${MAX_ROWS}];
uniform float u_band[${MAX_ROWS}];    // drawable height = row height minus the separator
uniform float u_yHi[${MAX_ROWS}];     // device-px top of the ALWAYS_HIGH line band
uniform float u_yLo[${MAX_ROWS}];     // device-px top of the ALWAYS_LOW line band
uniform vec3  u_color[${MAX_ROWS}];
uniform float u_lineW;                // device px
uniform float u_edgeW;                // device px
uniform vec3  u_bg;
uniform vec3  u_sepColor;             // [MEASURED] #57575E between rows
uniform float u_sepH;                 // [MEASURED] 4 device px at dpr 2
uniform vec3  u_noData;
uniform float u_noDataWash;
uniform float u_noDataBorderA;
uniform float u_noDataBorderH;

flat in int v_row;
out vec4 fragColor;

// OR together every data column overlapping the screen column [q, q+1).
// Column j covers screen [j*scale+off, (j+1)*scale+off), so the overlap condition is
//   j*scale+off < q+1   and   (j+1)*scale+off > q
// which inverts exactly to the two bounds below. In the common case (scale == 1,
// off == 0) both collapse to j == q and this is a single texelFetch.
uint colBits(float q, out bool has) {
  float inv = 1.0 / u_map.x;
  int a = int(floor((q - u_map.y) * inv));
  int b = int(ceil((q + 1.0 - u_map.y) * inv)) - 1;
  a = max(a, 0);
  b = min(b, u_dataBins - 1);
  if (b < a) { has = false; return 0u; }
  has = true;
  uint acc = 0u;
  for (int j = a; j <= b; ++j) {
    if (j - a >= 8) break;            // hard bound; only reachable past the data end
    acc |= texelFetch(u_cols, ivec2(j, v_row), 0).r;
  }
  return acc;
}

void main() {
  int r = v_row;
  float x = gl_FragCoord.x;                 // pixel centre, device px
  float y = u_canvas.y - gl_FragCoord.y;    // top-down pixel centre
  float p = floor(x);                       // this pixel covers [p, p+1)

  // [MEASURED] Row separator: 4 device px of #57575E at the bottom of every row pitch.
  // Drawn before anything else and returned from, so neither the trace nor the NO_DATA
  // wash can bleed into it - in the screenshot the separator is a flat, unmixed colour.
  if (u_sepH > 0.0 && y >= u_rowTop[r] + u_band[r]) {
    fragColor = vec4(u_sepColor, 1.0);
    return;
  }

  bool has = false;
  uint own = 0u;
  if (u_dataBins > 0) own = colBits(p, has);

  if (!has || (own & 8u) != 0u) {
    // NO_DATA. Distinct from a flat line on purpose: a user must never read "we have
    // nothing here" as "the signal was idle here". The !has arm is past the end of the
    // capture; the bit3 arm is a gap the store declared inside it.
    vec3 c = mix(u_bg, u_noData, u_noDataWash);
    float bTop = u_rowTop[r];
    float bBot = bTop + u_noDataBorderH;
    float bc = clamp(min(bBot, y + 0.5) - max(bTop, y - 0.5), 0.0, 1.0);
    c = mix(c, u_noData, u_noDataBorderA * bc);
    fragColor = vec4(c, 1.0);
    return;
  }

  float pixTop = y - 0.5;
  float pixBot = y + 0.5;
  float bandTop = u_yHi[r];
  float bandBot = u_yLo[r] + u_lineW;

  float cov = 0.0;

  // ALWAYS_HIGH / ALWAYS_LOW: a horizontal line. A column with an edge never draws one,
  // it draws the full bar below instead.
  if ((own & 4u) == 0u) {
    float t = ((own & 1u) != 0u) ? u_yHi[r] : u_yLo[r];
    cov = clamp(min(t + u_lineW, pixBot) - max(t, pixTop), 0.0, 1.0);
  }

  // ONE_OR_MORE_TRANSITIONS: full-height bar, u_edgeW device px wide. Neighbours are
  // consulted only when the bar is wider than one column, and a gap column never lets
  // a bar bleed over its NO_DATA wash.
  float covY = clamp(min(bandBot, pixBot) - max(bandTop, pixTop), 0.0, 1.0);
  if (covY > 0.0) {
    int rad = int(ceil((u_edgeW - 1.0) * 0.5));
    float back = floor((u_edgeW - 1.0) * 0.5);
    for (int dq = -rad; dq <= rad; ++dq) {
      float q = p + float(dq);
      bool h2 = true;
      uint b = own;
      if (dq != 0) b = colBits(q, h2);
      if (!h2) continue;
      if ((b & 4u) == 0u) continue;
      if ((b & 8u) != 0u) continue;
      float x0 = q - back;
      float covX = clamp(min(x0 + u_edgeW, p + 1.0) - max(x0, p), 0.0, 1.0);
      cov = max(cov, covX * covY);
    }
  }

  fragColor = vec4(mix(u_bg, u_color[r], cov), 1.0);
}
`;

/**
 * A CPU rasteriser for the same picture, used only as a control for the GPU path.
 *
 * It deliberately does NOT reuse planColumns() or the atlas. It asks the store for one
 * column at a time, with `bins = 1`, over the pixel column's exact sample range. That is
 * far too slow to ship, but it means the column classification comes straight from the
 * store instead of through the affine map the shader inverts, so a bug in the plan, in
 * the texture layout, in the instanced row indexing or in the shader's column arithmetic
 * shows up as a pixel difference instead of cancelling out.
 *
 * What it does NOT control for: it was written by the same author from the same reading
 * of one spec, so both paths would share any misreading of it. It controls
 * implementation, not interpretation. Stated here rather than left for a critic to find.
 */

import type { SampleStore } from '../data/types.js';
import type { LayoutMetrics } from './layout.js';
import { parseHexColor, type Theme } from './theme.js';

export interface CpuRasterOptions {
  store: SampleStore;
  channels: readonly number[];
  /** Integer sample range. The control is only exact for integer, in-range viewports. */
  start: number;
  end: number;
  widthPx: number;
  heightPx: number;
  layout: LayoutMetrics;
  theme: Theme;
}

export function cpuRaster(o: CpuRasterOptions): { width: number; height: number; data: Uint8Array } {
  const { store, channels, start, end, widthPx, heightPx, layout, theme } = o;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error('cpuRaster is only defined for integer viewports');
  }
  if (start < 0 || end > store.length) throw new Error('cpuRaster is only defined inside the capture');

  const data = new Uint8Array(widthPx * heightPx * 4);
  const bg = parseHexColor(theme.background).map((v) => Math.round(v * 255));
  const noData = parseHexColor(theme.noDataColor).map((v) => Math.round(v * 255));
  const noDataBorder = layout.noDataBorder;
  for (let i = 0; i < widthPx * heightPx; i++) {
    data[i * 4] = bg[0]!;
    data[i * 4 + 1] = bg[1]!;
    data[i * 4 + 2] = bg[2]!;
    data[i * 4 + 3] = 255;
  }

  const W = end - start;
  const lw = layout.lineWidth;
  const ew = layout.edgeWidth;
  const back = Math.floor((ew - 1) / 2);

  for (let r = 0; r < channels.length; r++) {
    const ch = channels[r]!;
    const g = layout.rows[r];
    if (!g) throw new Error(`layout has no row ${r}`);
    if (g.top >= heightPx) break;
    const rgb = parseHexColor(theme.channelColors[ch % theme.channelColors.length]!)
      .map((v) => Math.round(v * 255));

    // Classify every column first; the transition bar consults its neighbours.
    const bits = new Uint8Array(widthPx);
    for (let x = 0; x < widthPx; x++) {
      let c0 = start + Math.floor((x * W) / widthPx);
      let c1 = start + Math.floor(((x + 1) * W) / widthPx);
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > end) c1 = end;
      if (c0 >= end) {
        bits[x] = 0;
        continue;
      }
      bits[x] = store.query(ch, c0, c1, 1).packed[0]!;
    }

    // Row separator, flat over the bottom of the row pitch.
    const sepRgb = parseHexColor(theme.rowSeparatorColor).map((v) => Math.round(v * 255));
    for (let y = g.top + g.bandHeight; y < Math.min(g.top + g.height, heightPx); y++) {
      for (let x = 0; x < widthPx; x++) {
        const i = (y * widthPx + x) * 4;
        data[i] = sepRgb[0]!;
        data[i + 1] = sepRgb[1]!;
        data[i + 2] = sepRgb[2]!;
      }
    }

    const bandTop = g.yHiTop;
    const bandBot = g.yLoTop + lw;
    for (let x = 0; x < widthPx; x++) {
      const b = bits[x]!;
      for (let y = g.top; y < Math.min(g.top + g.bandHeight, heightPx); y++) {
        const i = (y * widthPx + x) * 4;
        if ((b & 8) !== 0) {
          // NO_DATA, bit3: the same wash and top border the shader draws. The low/high
          // and edge bits of a gap column are best effort and ignored.
          let c = bg[0]! + (noData[0]! - bg[0]!) * theme.noDataWashAlpha;
          let c1 = bg[1]! + (noData[1]! - bg[1]!) * theme.noDataWashAlpha;
          let c2 = bg[2]! + (noData[2]! - bg[2]!) * theme.noDataWashAlpha;
          if (y - g.top < noDataBorder) {
            c += (noData[0]! - c) * theme.noDataBorderAlpha;
            c1 += (noData[1]! - c1) * theme.noDataBorderAlpha;
            c2 += (noData[2]! - c2) * theme.noDataBorderAlpha;
          }
          data[i] = Math.round(c);
          data[i + 1] = Math.round(c1);
          data[i + 2] = Math.round(c2);
          continue;
        }
        const pixTop = y;
        const pixBot = y + 1;
        let cov = 0;
        if ((b & 4) === 0) {
          const t = (b & 1) !== 0 ? g.yHiTop : g.yLoTop;
          cov = clamp01(Math.min(t + lw, pixBot) - Math.max(t, pixTop));
        }
        const covY = clamp01(Math.min(bandBot, pixBot) - Math.max(bandTop, pixTop));
        if (covY > 0) {
          const rad = Math.ceil((ew - 1) / 2);
          for (let dq = -rad; dq <= rad; dq++) {
            const q = x + dq;
            if (q < 0 || q >= widthPx) continue;
            if ((bits[q]! & 4) === 0) continue;
            if ((bits[q]! & 8) !== 0) continue;
            const x0 = q - back;
            const covX = clamp01(Math.min(x0 + ew, x + 1) - Math.max(x0, x));
            cov = Math.max(cov, covX * covY);
          }
        }
        if (cov <= 0) continue;
        data[i] = Math.round(bg[0]! + (rgb[0]! - bg[0]!) * cov);
        data[i + 1] = Math.round(bg[1]! + (rgb[1]! - bg[1]!) * cov);
        data[i + 2] = Math.round(bg[2]! + (rgb[2]! - bg[2]!) * cov);
      }
    }
  }
  return { width: widthPx, height: heightPx, data };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

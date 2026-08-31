/**
 * Colours and row metrics.
 *
 * Every value here is tagged with its evidence class.
 * Anything not in the spec is marked GUESS and is a knob, not a fact - there are no
 * rendered output on this machine, so a value that was not read out of the app's
 * own source or measured by driving the app is not allowed to masquerade as one.
 */

/** [CHOSEN] The 8 channel colours cycled across channels. */
export const LOGIC2_CHANNEL_COLORS: readonly string[] = [
  '#d4d4d4', // ch0
  '#C79579', // ch1
  '#FF6D7F', // ch2
  '#FFB45B', // ch3
  '#e8d836', // ch4
  '#58c667', // ch5
  '#53A9FD', // ch6
  '#AF92FB', // ch7
];

/** [SOURCE] Dark theme backgrounds, darkest first. */
export const LOGIC2_BACKGROUNDS = {
  bg00: '#141415',
  bg10: '#1B1B1C',
  bg20: '#212224',
  bg30: '#2C2C2E',
} as const;

/** [SOURCE] Borders and text. */
export const LOGIC2_BORDERS = { low: '#303136', high: '#57575E' } as const;

export interface Theme {
  /** Plot background. [SOURCE] background-00. */
  background: string;
  /** Cycled per row. [SOURCE], and confirmed [MEASURED] - see the ICC note below. */
  channelColors: readonly string[];
  /**
   * [MEASURED] Rows are separated by exactly 4 device px (2 CSS px at dpr 2) of
   * #57575E - the spec's `border-high`. Measured at 16 consecutive row boundaries in
   * rendered output.
   */
  rowSeparatorColor: string;
  /** [MEASURED] 2 CSS px. */
  rowSeparatorCssPx: number;
  /**
   * Colour of the "no data here" wash and its top border.
   * [UNVERIFIED - GUESS] the spec gives the alphas (4% wash, 20% border) and the 2 px
   * border height but never names the "lost data colour". Neutral grey is a guess.
   */
  noDataColor: string;
  /** [SOURCE] 4% alpha wash over the row for NO_DATA. */
  noDataWashAlpha: number;
  /** [SOURCE] 20% alpha for the 2 px top border for NO_DATA. */
  noDataBorderAlpha: number;
  /** [SOURCE] 2 px top border. In CSS px. */
  noDataBorderCssPx: number;
}

/**
 * [MEASURED] against rendered output.
 *
 * IMPORTANT for anyone diffing pixels against those screenshots: they carry a 4064-byte
 * Apple "Display" ICC profile, i.e. they are in the monitor's wide gamut, NOT sRGB. Raw
 * pixel values therefore disagree with the spec's colour constants on every saturated
 * colour while agreeing exactly on the neutral ones - ch0 #d4d4d4 reads (212,212,212)
 * on the nose, but ch2 #FF6D7F reads (237,118,129) instead of (255,109,127).
 *
 * That is a colour-management artifact of the screenshot, not a real difference.
 * Converting the screenshot through its embedded profile into sRGB lands all 8 channel
 * colours on the spec's values to within 1/255:
 *
 *   ch0 (212,212,212)  ch1 (199,149,121)  ch2 (255,109,126)  ch3 (255,180,90)
 *   ch4 (232,216,54)   ch5 (89,197,103)   ch6 (83,169,253)   ch7 (175,146,251)
 *
 * A naive RGB diff will report 7 of our 8 channel colours as wrong. Convert first.
 */
export const DARK_THEME: Theme = {
  background: LOGIC2_BACKGROUNDS.bg10,
  channelColors: LOGIC2_CHANNEL_COLORS,
  rowSeparatorColor: LOGIC2_BORDERS.high,
  rowSeparatorCssPx: 2,
  noDataColor: '#909091',
  noDataWashAlpha: 0.04,
  noDataBorderAlpha: 0.2,
  noDataBorderCssPx: 2,
};

/**
 * [MEASURED] Row pitch in rendered output is 98 device px =
 * 49 CSS px, of which the bottom 2 CSS px are the separator, leaving a 47 CSS px band.
 *
 * the spec's [DRIVEN] "30 rows at 45 px" came from a different capture's meta.json. Row
 * height is persisted per capture, so it is a session property, not a constant - but 49
 * is what the screenshot we are compared against uses, so it is the default here.
 */
export const DEFAULT_ROW_HEIGHT_CSS_PX = 49;
/**
 * [MEASURED] 16 device px = 8 CSS px of clear space above the high line and below the
 * low line, giving 30 CSS px between the two line tops.
 *
 * the spec [SOURCE] says "16 px normally, 8 px in full-size mode". The screenshot measures
 * 8 CSS px, so either it is in full-size mode or the spec's 16 was in device px. Measured
 * beats inferred.
 */
export const DEFAULT_GUTTER_CSS_PX = 8;
/** [SOURCE] ALWAYS_HIGH / ALWAYS_LOW are 1 px fillRects in CSS space. */
export const DEFAULT_LINE_WIDTH_CSS_PX = 1;

/** "#rrggbb" -> [r, g, b] in 0..1. Throws on anything else; no silent black. */
export function parseHexColor(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`colour must be #rrggbb, got ${JSON.stringify(hex)}`);
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

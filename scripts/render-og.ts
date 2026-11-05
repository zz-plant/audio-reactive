/**
 * Renders the link-preview card (`site/og.png`, 1200x630) that chat apps and
 * social sites show when someone shares the site.
 *
 *   bun run og:png
 *
 * The picture on the card is real output: a synthetic 120 BPM drum loop is
 * run through the package's own spectrum, beat tracker and HPSS code, and the
 * card draws the byte spectrogram, the beat envelope and the detected bass
 * beats it produced. The card is HTML screenshotted by a headless Chrome or
 * Chromium found on the machine (CHROME_PATH, then the usual binary names).
 * build-site.ts calls `renderOgPng` too, so the deployed card is redrawn from
 * the code being deployed; when no browser is found it keeps the committed
 * site/og.png.
 */
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyseBlockBytes,
  buildHannWindow,
  buildTwiddleTable,
  createBeatTracker,
  createHarmonicPercussiveAnalyser,
  getFrequencyBandLevels,
  getWeightedEnergy,
} from '../src/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 1200;
const HEIGHT = 630;
const SAMPLE_RATE = 44_100;
const FFT_SIZE = 1024;
const BPM = 120;
/** Analysed length, and the part drawn (after the trackers settle). */
const SECONDS = 5;
const SHOWN_FROM_S = 1;
/** Spectrogram rows, log-spaced between these frequencies. */
const ROWS = 72;
const LOW_HZ = 40;
const HIGH_HZ = 12_000;

export const OG_IMAGE_ALT =
  'audio-reactive: a glowing spectrogram of a drum loop with the beat envelope pulsing above it and a marker on every detected kick, under the headline "Make it move to the music."';

export type Analysis = {
  /** Column-major spectrogram, ROWS bytes per analysis block. */
  spectrogram: Uint8Array;
  columns: number;
  beatIntensity: number[];
  bassBeat: boolean[];
  percussiveRatio: number[];
};

/** Kick on every beat, snare on 2 and 4, hats on the offbeats, a pad. */
function drumLoop(): Float32Array {
  let seed = 7;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const beat = 60 / BPM;
  const out = new Float32Array(SAMPLE_RATE * SECONDS);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const inBeat = t % beat;
    const index = Math.floor(t / beat);
    let v =
      0.05 *
      (Math.sin(2 * Math.PI * 220 * t) +
        Math.sin(2 * Math.PI * 277.2 * t) +
        Math.sin(2 * Math.PI * 329.6 * t));
    if (inBeat < 0.18) {
      const phase =
        2 * Math.PI * (55 * inBeat + (120 / 35) * (1 - Math.exp(-inBeat * 35)));
      v += 0.9 * Math.exp(-inBeat * 18) * Math.sin(phase);
    }
    if (index % 2 === 1 && inBeat < 0.15) {
      v += 0.35 * Math.exp(-inBeat * 25) * noise();
    }
    const hat = (t + beat / 2) % beat;
    if (hat < 0.03) v += 0.12 * Math.exp(-hat * 120) * noise();
    out[i] = v;
  }
  return out;
}

export function analyseLoop(): Analysis {
  const samples = drumLoop();
  const window = buildHannWindow(FFT_SIZE);
  const twiddles = buildTwiddleTable(FFT_SIZE);
  const scratch = {
    real: new Float32Array(FFT_SIZE),
    imag: new Float32Array(FFT_SIZE),
  };
  const spectrum = new Uint8Array(FFT_SIZE / 2);
  const beats = createBeatTracker();
  const hpss = createHarmonicPercussiveAnalyser();
  const blockMs = (FFT_SIZE / SAMPLE_RATE) * 1000;
  const binHz = SAMPLE_RATE / FFT_SIZE;
  const rowBins = Array.from({ length: ROWS }, (_, r) => {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (r / (ROWS - 1));
    return Math.min(spectrum.length - 1, Math.round(hz / binHz));
  });

  const columns: Uint8Array[] = [];
  const beatIntensity: number[] = [];
  const bassBeat: boolean[] = [];
  const percussiveRatio: number[] = [];
  for (let start = 0; start + FFT_SIZE <= samples.length; start += FFT_SIZE) {
    analyseBlockBytes(
      samples.subarray(start, start + FFT_SIZE),
      window,
      twiddles,
      spectrum,
      scratch,
    );
    const bands = getFrequencyBandLevels(spectrum, SAMPLE_RATE);
    const weightedEnergy = getWeightedEnergy(bands);
    const hp = hpss.analyse(spectrum, SAMPLE_RATE);
    const update = beats.update(
      { bands, weightedEnergy, deltaMs: blockMs },
      (start / SAMPLE_RATE) * 1000,
    );
    if (start / SAMPLE_RATE < SHOWN_FROM_S) continue;
    columns.push(Uint8Array.from(rowBins, (bin) => spectrum[bin] ?? 0));
    beatIntensity.push(update.beatIntensity);
    bassBeat.push(update.isBeat && update.beatBass);
    percussiveRatio.push(hp.percussiveRatio);
  }
  const spectrogram = new Uint8Array(columns.length * ROWS);
  columns.forEach((column, c) => spectrogram.set(column, c * ROWS));
  return {
    spectrogram,
    columns: columns.length,
    beatIntensity,
    bassBeat,
    percussiveRatio,
  };
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export function ogCardHtml(
  analysis: Analysis = analyseLoop(),
  version = packageVersion(),
): string {
  const data = JSON.stringify({
    rows: ROWS,
    columns: analysis.columns,
    spectrogram: Buffer.from(analysis.spectrogram).toString('base64'),
    beatIntensity: analysis.beatIntensity.map((v) => +v.toFixed(3)),
    bassBeat: analysis.bassBeat.map(Number),
  });
  const plotW = WIDTH;
  const plotH = 280;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800&family=JetBrains+Mono:wght@500&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, "DejaVu Sans", sans-serif;
    color: #f3efe6;
    background: #0b0a10;
    position: relative;
  }
  canvas { position: absolute; left: 0; bottom: 0; width: ${plotW}px; height: ${plotH}px; }
  .shade { position: absolute; inset: 0; background: linear-gradient(180deg, #0b0a10 0%, #0b0a10 50%, rgba(11, 10, 16, 0) 57%); }
  .content { position: absolute; inset: 0; padding: 50px 52px; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 700; letter-spacing: -0.01em; }
  .brand svg { width: 46px; height: 46px; }
  .brand .tag { margin-left: auto; font: 500 20px "JetBrains Mono", ui-monospace, monospace; color: #a39d92; }
  h1 { margin-top: 30px; font-size: 84px; line-height: 1; font-weight: 800; letter-spacing: -0.04em; }
  h1 em { font-style: normal; background: linear-gradient(90deg, #ffd166, #ff7a59 60%, #e04f8b); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { margin-top: 18px; font-size: 27px; line-height: 1.3; color: #c9c2b6; }
  .chip { position: absolute; right: 40px; bottom: 28px; font: 500 20px "JetBrains Mono", ui-monospace, monospace; color: #0b0a10; background: rgba(243, 239, 230, 0.92); padding: 8px 14px; border-radius: 999px; }
  .note { position: absolute; left: 40px; bottom: 28px; font: 500 17px "JetBrains Mono", ui-monospace, monospace; color: #f3efe6; background: rgba(11, 10, 16, 0.78); padding: 8px 14px; border-radius: 999px; }
</style></head>
<body>
  <canvas id="c" width="${plotW * 2}" height="${plotH * 2}"></canvas>
  <div class="shade"></div>
  <div class="content">
    <div class="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#c9a227"/><path d="M4 16c3-7 5-7 8 0s5 7 8 0 5-7 8 0" fill="none" stroke="#1f2328" stroke-width="3" stroke-linecap="round"/></svg>
      audio-reactive
      <span class="tag">AudioWorklet · 0 deps</span>
    </div>
    <h1>Make it <em>move</em><br>to the music.</h1>
    <p class="sub">Beats, bands and transients for visualizers, off the main thread.</p>
  </div>
  <span class="note">real output · ${BPM} BPM drum loop · ● = detected kick</span>
  <span class="chip">npm i audio-reactive · v${version}</span>
<script>
  const d = ${data};
  const bytes = Uint8Array.from(atob(d.spectrogram), (ch) => ch.charCodeAt(0));
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Ember colour map: near-black, violet, red-orange, gold, cream.
  const stops = [[11,10,16],[58,18,92],[176,38,94],[255,122,89],[255,209,102],[255,246,220]];
  const colour = (v) => {
    const x = Math.min(1, Math.max(0, v)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  };

  // Spectrogram at native resolution, then scaled up smoothly.
  const small = document.createElement('canvas');
  small.width = d.columns; small.height = d.rows;
  const img = small.getContext('2d').createImageData(d.columns, d.rows);
  const medians = Array.from({ length: d.rows }, (_, r) => {
    const row = Array.from({ length: d.columns }, (_, c) => bytes[c * d.rows + r] / 255).sort((a, b) => a - b);
    return row[row.length >> 1];
  });
  for (let c = 0; c < d.columns; c++) {
    for (let r = 0; r < d.rows; r++) {
      // Steady tones would draw as flat bars; weight what rises above each
      // row's median so the hits carry the picture.
      const v = bytes[c * d.rows + r] / 255;
      const lift = Math.max(0, v - medians[r]) * 1.5;
      const [R, G, B] = colour(0.22 * v + 0.85 * Math.min(1, lift) ** 1.3);
      const p = ((d.rows - 1 - r) * d.columns + c) * 4;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
    }
  }
  small.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const specTop = H * 0.27;
  ctx.drawImage(small, 0, specTop, W, H - specTop);

  // Beat envelope as a glowing line riding above the spectrogram.
  const x = (i) => (i / (d.columns - 1)) * W;
  const y = (v) => specTop - 14 - Math.min(1, v) * (specTop - 44);
  ctx.lineJoin = 'round';
  for (const [width, alpha] of [[28, 0.12], [12, 0.28], [5, 1]]) {
    ctx.beginPath();
    d.beatIntensity.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = 'rgba(255, 209, 102,' + alpha + ')';
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // A marker and a vertical pulse on every detected kick.
  d.bassBeat.forEach((hit, i) => {
    if (!hit) return;
    const gx = x(i);
    const g = ctx.createLinearGradient(0, specTop, 0, H);
    g.addColorStop(0, 'rgba(255, 246, 220, 0.55)');
    g.addColorStop(1, 'rgba(255, 246, 220, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(gx - 3, specTop, 6, H - specTop);
    ctx.beginPath();
    ctx.arc(gx, y(d.beatIntensity[i]), 15, 0, Math.PI * 2);
    ctx.fillStyle = '#fff6dc';
    ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 30;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
</script>
</body></html>`;
}

/** A headless-capable Chrome or Chromium binary, or null when none is found. */
export function findChrome(): string | null {
  const env = process.env.CHROME_PATH;
  if (env) return env;
  for (const name of [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  for (const path of [
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    try {
      if (statSync(path)) return path;
    } catch {}
  }
  return null;
}

/**
 * Screenshots the card to `outPath`. Returns false, leaving `outPath`
 * untouched, when no browser is available or the screenshot fails.
 */
export function renderOgPng(outPath: string, html = ogCardHtml()): boolean {
  const chrome = findChrome();
  if (!chrome) return false;
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  try {
    const page = join(dir, 'card.html');
    const shot = join(dir, 'card.png');
    writeFileSync(page, html);
    const result = Bun.spawnSync(
      [
        chrome,
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        // Gives the web font time to load before the shot is taken.
        '--virtual-time-budget=8000',
        `--window-size=${WIDTH},${HEIGHT}`,
        `--screenshot=${shot}`,
        `file://${page}`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    if (result.exitCode !== 0) return false;
    try {
      if (statSync(shot).size === 0) return false;
    } catch {
      return false;
    }
    copyFileSync(shot, outPath);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const out = join(ROOT, 'site', 'og.png');
  if (!renderOgPng(out)) {
    console.error(
      'render-og: no headless Chrome or Chromium found; set CHROME_PATH to one.',
    );
    process.exit(1);
  }
  console.log(`wrote ${out}`);
}

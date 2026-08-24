import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clip, Dataset, MediaQaResult, Rect, Variant } from "./types.ts";
import { rel, stableId, writeJson } from "./util.ts";

const FFMPEG_ARGS = ["-hide_banner", "-loglevel", "error", "-y"];

function command(program: string, args: string[], maxBuffer = 32 * 1024 * 1024): Buffer {
  const result = spawnSync(program, args, { encoding: null, maxBuffer });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    throw new Error(`${program} failed (${result.status}): ${stderr.trim()}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

export function assertFfmpegAvailable(): void {
  command("ffmpeg", ["-version"]);
  command("ffprobe", ["-version"]);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function seedNumber(id: string): number {
  return Number.parseInt(stableId(id).slice(0, 6), 16);
}

function masterSvg(clip: Clip, dataset: Dataset): string {
  const { width, height } = dataset.canvas;
  const seed = seedNumber(clip.id);
  const circleX = Math.round(width * clip.focusX);
  const circleY = 180 + (seed % 260);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101423"/><stop offset="1" stop-color="#222a42"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${clip.accent}" stop-opacity=".72"/><stop offset="1" stop-color="${clip.accent}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${circleX}" cy="${circleY}" r="260" fill="url(#glow)"/>
  <path d="M0 ${530 + (seed % 60)} C 310 430, 760 700, 1280 470 L1280 720 L0 720Z" fill="#080b14" opacity=".68"/>
  <rect x="70" y="64" width="104" height="8" rx="4" fill="${clip.accent}"/>
  <text x="70" y="130" fill="#f5f7ff" font-family="DejaVu Sans, sans-serif" font-size="44" font-weight="700" letter-spacing="3">${xml(clip.title)}</text>
  <text x="70" y="174" fill="#aeb7ce" font-family="DejaVu Sans, sans-serif" font-size="20">ORIGINAL SYNTHETIC 16:9 MASTER · ${clip.id.toUpperCase()}</text>
  <g opacity=".5" fill="none" stroke="${clip.accent}" stroke-width="2"><rect x="${circleX - 82}" y="${circleY - 112}" width="164" height="224" rx="82"/><path d="M${circleX - 110} ${circleY + 125} Q${circleX} ${circleY + 60} ${circleX + 110} ${circleY + 125}"/></g>
</svg>`;
}

export interface CaptionLayout {
  bounds: Rect;
  algorithm: string;
}

export function captionLayout(clip: Clip, dataset: Dataset, variant: Variant): CaptionLayout {
  const lineHeight = 76;
  const padY = 28;
  const height = clip.caption.length * lineHeight + padY * 2;
  const baselineY = dataset.safeArea.y + dataset.safeArea.height - 36 - height;
  if (variant === "candidate" && clip.caption.length > 1) {
    const sourceLineHeight = 44;
    const sourceBlockAllowance = clip.caption.length * sourceLineHeight + 34;
    const preTransformTop = dataset.canvas.height - 42 - sourceBlockAllowance;
    const mistakenPortraitTop = Math.round(preTransformTop * (dataset.output.height / dataset.canvas.height));
    return {
      bounds: { x: 120, y: mistakenPortraitTop, width: 840, height },
      algorithm: "pre-transform-anchor-mapped-after-layout (known rc1 defect)",
    };
  }
  return {
    bounds: { x: 120, y: baselineY, width: 840, height },
    algorithm: "final-portrait-canvas-safe-area-anchor",
  };
}

function portraitSvg(clip: Clip, dataset: Dataset, variant: Variant | "none"): string {
  const { width, height } = dataset.output;
  const seed = seedNumber(clip.id);
  const focusShift = Math.round((clip.focusX - 0.5) * 420);
  const circleX = width / 2 + focusShift;
  const circleY = 520 + (seed % 360);
  const caption = variant === "none" ? "" : (() => {
    const layout = captionLayout(clip, dataset, variant);
    const text = clip.caption.map((line, index) => {
      const fittedFontSize = Math.min(58, Math.floor(720 / (line.length * 0.62)));
      return `<text x="540" y="${layout.bounds.y + 28 + 58 + index * 76}" text-anchor="middle" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="${fittedFontSize}" font-weight="700">${xml(line)}</text>`;
    }).join("\n");
    return `<g id="burned-caption" data-layout="${xml(layout.algorithm)}">
      <rect x="${layout.bounds.x}" y="${layout.bounds.y}" width="${layout.bounds.width}" height="${layout.bounds.height}" rx="28" fill="#05070c" fill-opacity=".94"/>
      ${text}
    </g>`;
  })();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101423"/><stop offset="1" stop-color="#222a42"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${clip.accent}" stop-opacity=".78"/><stop offset="1" stop-color="${clip.accent}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${circleX}" cy="${circleY}" r="500" fill="url(#glow)"/>
  <path d="M0 1120 C 180 980, 740 1450, 1080 1030 L1080 1920 L0 1920Z" fill="#080b14" opacity=".72"/>
  <rect x="90" y="126" width="118" height="10" rx="5" fill="${clip.accent}"/>
  <text x="90" y="210" fill="#f5f7ff" font-family="DejaVu Sans, sans-serif" font-size="56" font-weight="700" letter-spacing="3">${xml(clip.title)}</text>
  <text x="90" y="258" fill="#aeb7ce" font-family="DejaVu Sans, sans-serif" font-size="24">LOCKED PORTRAIT REFRAME · ${clip.id.toUpperCase()}</text>
  <g opacity=".48" fill="none" stroke="${clip.accent}" stroke-width="4"><rect x="${circleX - 132}" y="${circleY - 180}" width="264" height="360" rx="132"/><path d="M${circleX - 180} ${circleY + 205} Q${circleX} ${circleY + 95} ${circleX + 180} ${circleY + 205}"/></g>
  ${caption}
</svg>`;
}

async function svgToPng(svg: string, svgPath: string, pngPath: string, width: number, height: number): Promise<void> {
  await mkdir(dirname(svgPath), { recursive: true });
  await writeFile(svgPath, svg, "utf8");
  command("ffmpeg", [...FFMPEG_ARGS, "-i", svgPath, "-vf", `scale=${width}:${height}:flags=lanczos`, "-frames:v", "1", pngPath]);
}

function pngToMp4(pngPath: string, mp4Path: string, duration: number, fps: number): void {
  command("ffmpeg", [
    ...FFMPEG_ARGS,
    "-loop", "1", "-framerate", String(fps), "-i", pngPath,
    "-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
    "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4Path,
  ], 64 * 1024 * 1024);
}

export async function generateOriginal(clip: Clip, dataset: Dataset, root: string): Promise<{ poster: string; video: string }> {
  const dir = join(root, clip.id);
  const poster = join(dir, "master-16x9.png");
  const video = join(dir, "master-16x9.mp4");
  await svgToPng(masterSvg(clip, dataset), join(dir, "master-16x9.svg"), poster, dataset.canvas.width, dataset.canvas.height);
  pngToMp4(poster, video, clip.durationSeconds, dataset.output.fps);
  await writeJson(join(dir, "caption-cues.json"), {
    clipId: clip.id,
    language: "en",
    cues: [{ startSeconds: 0, endSeconds: clip.durationSeconds, lines: clip.caption }],
  });
  await writeJson(join(dir, "edit-plan.json"), {
    schemaVersion: "1.0",
    clipId: clip.id,
    locked: true,
    portraitReframe: { focusX: clip.focusX, focusY: 0.5 },
    captionStyle: { family: "DejaVu Sans", maxSizePx: 58, lineHeightPx: 76, blockWidthPx: 840, maxTextWidthPx: 720, fit: "deterministic-font-size" },
  });
  return { poster, video };
}

export async function renderNoCaption(clip: Clip, dataset: Dataset, mediaDir: string): Promise<string> {
  const output = join(mediaDir, clip.id, "no-caption.png");
  await svgToPng(portraitSvg(clip, dataset, "none"), join(mediaDir, clip.id, "no-caption.svg"), output, dataset.output.width, dataset.output.height);
  return output;
}

export async function renderVariant(
  clip: Clip,
  dataset: Dataset,
  variant: Variant,
  mediaDir: string,
): Promise<{ poster: string; video: string; renderDurationMs: number; declaredLayout: CaptionLayout }> {
  const dir = join(mediaDir, clip.id);
  const poster = join(dir, `${variant}.png`);
  const video = join(dir, `${variant}.mp4`);
  const start = process.hrtime.bigint();
  await svgToPng(portraitSvg(clip, dataset, variant), join(dir, `${variant}.svg`), poster, dataset.output.width, dataset.output.height);
  pngToMp4(poster, video, clip.durationSeconds, dataset.output.fps);
  const renderDurationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { poster, video, renderDurationMs, declaredLayout: captionLayout(clip, dataset, variant) };
}

function rgbFrame(path: string): Buffer {
  return command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], 16 * 1024 * 1024);
}

function measuredDiffBounds(noCaptionPath: string, captionPath: string, width: number, height: number): Rect | null {
  const left = rgbFrame(noCaptionPath);
  const right = rgbFrame(captionPath);
  const expected = width * height * 3;
  if (left.length !== expected || right.length !== expected) {
    throw new Error(`Decoded frame size mismatch: expected ${expected}, received ${left.length}/${right.length}`);
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 3;
    const changed = Math.max(
      Math.abs(left[index] - right[index]),
      Math.abs(left[index + 1] - right[index + 1]),
      Math.abs(left[index + 2] - right[index + 2]),
    ) > 8;
    if (!changed) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function violation(bounds: Rect | null, safe: Rect): number {
  if (!bounds) return Number.POSITIVE_INFINITY;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return Math.max(0, safe.x - bounds.x, safe.y - bounds.y, right - (safe.x + safe.width), bottom - (safe.y + safe.height));
}

function probe(path: string): { width: number; height: number; duration: number } {
  const data = JSON.parse(command("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", path]).toString("utf8"));
  const stream = data.streams?.[0] ?? {};
  return { width: Number(stream.width), height: Number(stream.height), duration: Number(data.format?.duration) };
}

export function runMediaQa(args: {
  experimentId: string;
  clip: Clip;
  dataset: Dataset;
  variant: Variant;
  noCaptionPath: string;
  posterPath: string;
  videoPath: string;
  renderDurationMs: number;
}): MediaQaResult {
  const { experimentId, clip, dataset, variant, noCaptionPath, posterPath, videoPath, renderDurationMs } = args;
  const bounds = measuredDiffBounds(noCaptionPath, posterPath, dataset.output.width, dataset.output.height);
  const violationPx = violation(bounds, dataset.safeArea);
  const info = probe(videoPath);
  const outputValid = info.width === dataset.output.width && info.height === dataset.output.height &&
    Number.isFinite(info.duration) && Math.abs(info.duration - clip.durationSeconds) <= 0.15;
  return {
    experimentId,
    clipId: clip.id,
    variant,
    outputPath: rel(videoPath),
    noCaptionPath: rel(noCaptionPath),
    captionBounds: bounds,
    safeArea: dataset.safeArea,
    violationPx: Number.isFinite(violationPx) ? violationPx : -1,
    safeAreaPass: violationPx === 0,
    outputValid,
    width: info.width,
    height: info.height,
    durationSeconds: info.duration,
    expectedDurationSeconds: clip.durationSeconds,
    renderDurationMs: Math.round(renderDurationMs * 10) / 10,
    runCompleted: true,
    traceId: stableId(experimentId, variant, clip.id, "trace").slice(0, 32),
  };
}

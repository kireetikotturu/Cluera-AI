import type { NativeImage } from 'electron';

export interface ScreenOptimizationOptions {
  sourceName: string;
  maxBytes: number;
  maxDimension: number;
  scaleFactor?: number;
  sessionHint?: string;
}

export interface OptimizedScreenImage {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  preserveSmallText: boolean;
  resized: boolean;
}

const TEXT_DENSE_SOURCE = /visual studio|\bvscode\b|\bcode\b|terminal|powershell|command prompt|\bcmd\b|devtools|developer tools|console|intellij|pycharm|webstorm|android studio|eclipse|xcode|notepad|sublime|vim|emacs|git bash/i;
const VISUAL_SOURCE = /powerpoint|keynote|photos?|image viewer|preview|youtube|video|figma|canva/i;

export type ScreenContentHint = 'text-dense' | 'visual' | 'uncertain';

export function inferScreenContentHint(sourceName: string, sessionHint = ''): ScreenContentHint {
  const cheapMetadata = `${sourceName} ${sessionHint}`;
  if (TEXT_DENSE_SOURCE.test(cheapMetadata)) return 'text-dense';
  if (VISUAL_SOURCE.test(cheapMetadata)) return 'visual';
  return 'uncertain';
}

function resizeWithin(image: NativeImage, maxDimension: number): NativeImage {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= maxDimension) return image;
  return image.resize({
    width: width >= height ? maxDimension : undefined,
    height: height > width ? maxDimension : undefined,
    quality: 'best',
  });
}

/**
 * Optimizes a captured Electron NativeImage without cropping. The policy favors
 * lossless PNG for normal-sized screenshots and uses conservative JPEG quality
 * only when network payload size would otherwise dominate latency.
 */
export function optimizeScreenImage(image: NativeImage, options: ScreenOptimizationOptions): OptimizedScreenImage {
  if (image.isEmpty()) throw new Error('The selected window did not provide a screenshot.');
  const original = image.getSize();
  if (original.width < 1 || original.height < 1) throw new Error('The screenshot has invalid dimensions.');

  const hint = inferScreenContentHint(options.sourceName, options.sessionHint);
  const highDpi = (options.scaleFactor ?? 1) > 1.25;
  const preserveSmallText = hint !== 'visual';
  const preferredDimension = hint === 'visual'
    ? Math.min(options.maxDimension, 1_920)
    : hint === 'text-dense' || highDpi
      ? options.maxDimension
      : Math.min(options.maxDimension, 2_304);

  let optimized = resizeWithin(image, preferredDimension);
  let resized = optimized !== image;
  let bytes = optimized.toPNG();
  let mimeType: OptimizedScreenImage['mimeType'] = 'image/png';
  const losslessBudget = Math.min(options.maxBytes, hint === 'text-dense' ? 2_400_000 : preserveSmallText ? 1_900_000 : 1_400_000);

  if (bytes.byteLength > losslessBudget) {
    const qualities = hint === 'text-dense' ? [94, 90, 86] : preserveSmallText ? [92, 88, 84] : [86, 82, 78];
    mimeType = 'image/jpeg';
    for (const quality of qualities) {
      bytes = optimized.toJPEG(quality);
      if (bytes.byteLength <= options.maxBytes) break;
    }
  }

  // Keep the hard byte ceiling from the original flow. If quality alone is not
  // enough, reduce dimensions gradually; never crop and never upscale.
  while (bytes.byteLength > options.maxBytes && Math.max(optimized.getSize().width, optimized.getSize().height) > 960) {
    const current = optimized.getSize();
    const nextMax = Math.max(960, Math.floor(Math.max(current.width, current.height) * 0.88));
    optimized = resizeWithin(optimized, nextMax);
    resized = true;
    bytes = optimized.toJPEG(preserveSmallText ? 88 : 80);
    mimeType = 'image/jpeg';
  }
  if (bytes.byteLength > options.maxBytes) throw new Error(`Screenshot exceeds the ${options.maxBytes} byte limit after safe optimization.`);

  const finalSize = optimized.getSize();
  return { bytes, mimeType, width: finalSize.width, height: finalSize.height, preserveSmallText, resized };
}

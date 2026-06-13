import type { SceneGuardMetrics } from "./obs-scene-guard.ts";
import { analyzeSceneGuardPixels } from "./obs-scene-guard.ts";

let analysisCanvas: HTMLCanvasElement | null = null;
let analysisContext: CanvasRenderingContext2D | null = null;

function loadImage(imageDataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode scene guard screenshot"));
    image.src = imageDataUrl;
  });
}

function getAnalysisContext() {
  if (!analysisCanvas) {
    analysisCanvas = document.createElement("canvas");
    analysisContext = analysisCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }

  if (!analysisCanvas || !analysisContext) {
    throw new Error("Scene guard analysis context unavailable");
  }

  return { canvas: analysisCanvas, context: analysisContext };
}

export async function analyzeSceneGuardImageDataUrl(
  imageDataUrl: string,
): Promise<SceneGuardMetrics> {
  const image = await loadImage(imageDataUrl);
  const { canvas, context } = getAnalysisContext();

  canvas.width = image.width;
  canvas.height = image.height;
  context.clearRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);

  const { data } = context.getImageData(0, 0, image.width, image.height);
  return analyzeSceneGuardPixels({
    data,
    width: image.width,
    height: image.height,
  });
}

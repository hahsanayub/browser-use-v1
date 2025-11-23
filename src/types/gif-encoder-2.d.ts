declare module 'gif-encoder-2' {
  import { CanvasRenderingContext2D } from 'canvas';

  class GifEncoder {
    constructor(
      width: number,
      height: number,
      algorithm?: string,
      useOptimizer?: boolean,
      totalFrames?: number
    );
    createReadStream(): NodeJS.ReadableStream;
    start(): void;
    setDelay(delay: number): void;
    setQuality(quality: number): void;
    setRepeat(repeat: number): void;
    setTransparent(color: number): void;
    addFrame(ctx: any): void;
    finish(): void;
    out: {
      getData(): Buffer;
    };
  }

  export = GifEncoder;
}

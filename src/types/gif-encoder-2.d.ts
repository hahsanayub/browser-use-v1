declare module 'gif-encoder-2' {
  class GIFEncoder {
    constructor(
      width: number,
      height: number,
      algorithm?: string,
      useOptimizer?: boolean,
      totalFrames?: number
    );
    setDelay(delay: number): void;
    setQuality(quality: number): void;
    setRepeat(repeat: number): void;
    setTransparent(color: number): void;
    start(): void;
    addFrame(
      ctx: CanvasRenderingContext2D | import('canvas').CanvasRenderingContext2D
    ): void;
    finish(): void;
    createReadStream(): NodeJS.ReadableStream;
    out: {
      getData(): Buffer;
    };
  }

  export default GIFEncoder;
}

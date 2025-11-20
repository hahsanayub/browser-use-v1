declare module 'gif-encoder-2' {
    import { CanvasRenderingContext2D } from 'canvas';

    class GifEncoder {
        constructor(width: number, height: number, algorithm?: string, useOptimizer?: boolean, totalFrames?: number);
        start(): void;
        setDelay(delay: number): void;
        setQuality(quality: number): void;
        setRepeat(repeat: number): void;
        setTransparent(color: number): void;
        addFrame(ctx: CanvasRenderingContext2D): void;
        finish(): void;
        out: {
            getData(): Buffer;
        };
    }

    export = GifEncoder;
}

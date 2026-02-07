declare module 'minimatch' {
  export interface MinimatchOptions {
    [key: string]: unknown;
  }

  export default function minimatch(
    target: string,
    pattern: string,
    options?: MinimatchOptions
  ): boolean;
}

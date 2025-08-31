/**
 * Visualization Service - Node.js Implementation
 *
 * Features:
 * - Operation history GIF generation
 * - Unicode text rendering support
 * - Smart font loading and fallback
 * - Dynamic layout with rounded rectangles
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  Canvas,
  CanvasRenderingContext2D,
  createCanvas,
  loadImage,
  registerFont,
} from 'canvas';
// Note: Using a more modern approach for GIF generation
// We'll implement a simplified version that can be enhanced later
import type { AgentHistory } from '../types/agent';
import { getLogger } from './logging';

// Known placeholder image data for about:blank pages - a 4x4 white PNG
export const PLACEHOLDER_4PX_SCREENSHOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGP8//8/AwwwMSAB3BwAlm4DBfIlvvkAAAAASUVORK5CYII=';

interface GifOptions {
  outputPath?: string;
  duration?: number;
  showGoals?: boolean;
  showTask?: boolean;
  showLogo?: boolean;
  fontSize?: number;
  titleFontSize?: number;
  goalFontSize?: number;
  margin?: number;
  lineSpacing?: number;
}

interface FontConfig {
  family: string;
  size: number;
}

interface TextStyle {
  color: string;
  backgroundColor: string;
  padding: number;
  borderRadius: number;
}

export class VisualizationService {
  private logger = getLogger();
  private fontLoaded = false;
  private availableFonts: string[] = [];

  constructor() {
    this.initializeFonts();
  }

  /**
   * Initialize font system with fallback options
   */
  private async initializeFonts(): Promise<void> {
    // Font options in order of preference
    const fontOptions = [
      'Microsoft YaHei', // 微软雅黑
      'SimHei', // 黑体
      'SimSun', // 宋体
      'Noto Sans CJK SC', // 思源黑体
      'WenQuanYi Micro Hei', // 文泉驿微米黑
      'Helvetica',
      'Arial',
      'DejaVu Sans',
      'Verdana',
    ];

    for (const fontName of fontOptions) {
      try {
        if (os.platform() === 'win32') {
          // Windows font path handling
          const windowsFontDir =
            process.env.WIN_FONT_DIR || 'C:\\Windows\\Fonts';
          const fontPath = path.join(windowsFontDir, `${fontName}.ttf`);

          if (await this.fileExists(fontPath)) {
            registerFont(fontPath, { family: fontName });
            this.availableFonts.push(fontName);
            this.logger.debug(`Registered font: ${fontName}`);
          }
        } else {
          // Unix-like systems - try common font paths
          const commonPaths = [
            `/usr/share/fonts/truetype/${fontName.toLowerCase()}/${fontName}.ttf`,
            `/System/Library/Fonts/${fontName}.ttf`,
            `/usr/share/fonts/TTF/${fontName}.ttf`,
          ];

          for (const fontPath of commonPaths) {
            if (await this.fileExists(fontPath)) {
              registerFont(fontPath, { family: fontName });
              this.availableFonts.push(fontName);
              this.logger.debug(`Registered font: ${fontName}`);
              break;
            }
          }
        }
      } catch (error) {
        this.logger.debug(`Failed to register font ${fontName}: ${error}`);
      }
    }

    this.fontLoaded = this.availableFonts.length > 0;

    if (!this.fontLoaded) {
      this.logger.warn('No custom fonts loaded, using system default');
    }
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate operation history GIF
   *
   * @param task Task description text
   * @param history Agent history containing screenshots and actions
   * @param options GIF generation options
   */
  async createHistoryGif(
    task: string,
    history: AgentHistory[],
    options: GifOptions = {}
  ): Promise<string> {
    const {
      outputPath = 'agent_history.gif',
      duration = 3000,
      showGoals = true,
      showTask = true,
      showLogo = false,
      fontSize = 40,
      titleFontSize = 56,
      goalFontSize = 44,
      margin = 40,
      lineSpacing = 1.5,
    } = options;

    if (!history.length) {
      this.logger.warn('No history to create GIF from');
      return outputPath;
    }

    // Get all screenshots from history
    const screenshots = this.extractScreenshots(history);

    if (!screenshots.length) {
      this.logger.warn('No screenshots found in history');
      return outputPath;
    }

    // Find first non-placeholder screenshot
    const firstRealScreenshot = screenshots.find(
      (screenshot) => screenshot && screenshot !== PLACEHOLDER_4PX_SCREENSHOT
    );

    if (!firstRealScreenshot) {
      this.logger.warn('No valid screenshots found (all are placeholders)');
      return outputPath;
    }

    // Load first screenshot to get dimensions
    const firstImage = await this.loadImageFromBase64(firstRealScreenshot);
    const { width, height } = firstImage;

    const canvases: Canvas[] = [];

    this.logger.info(
      `Generating ${outputPath} with ${screenshots.length} frames`
    );

    // Create task frame if requested
    if (showTask && task) {
      const taskFrame = await this.createTaskFrame(
        task,
        firstRealScreenshot,
        width,
        height,
        {
          family: this.getPreferredFont(),
          size: titleFontSize,
        },
        lineSpacing,
        showLogo
      );
      canvases.push(taskFrame);
    }

    // Process each history item with its corresponding screenshot
    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      const screenshot = screenshots[i];

      if (!screenshot || screenshot === PLACEHOLDER_4PX_SCREENSHOT) {
        this.logger.debug(`Skipping placeholder screenshot at step ${i + 1}`);
        continue;
      }

      try {
        let canvas = await this.loadImageFromBase64(screenshot);

        if (showGoals && item.model_output?.current_state?.next_goal) {
          canvas = await this.addOverlayToImage(
            canvas,
            i + 1,
            item.model_output.current_state.next_goal,
            {
              fontSize,
              titleFontSize,
              goalFontSize,
              margin,
              fontFamily: this.getPreferredFont(),
            },
            showLogo
          );
        }

        canvases.push(canvas);
      } catch (error) {
        this.logger.error(`Failed to process screenshot ${i + 1}: ${error}`);
      }
    }

    // For now, we'll save individual frames as PNG files
    // This can be enhanced later with proper GIF encoding
    if (canvases.length > 0) {
      if (canvases.length === 1) {
        // Save single frame as PNG
        const buffer = canvases[0].toBuffer('image/png');
        await fs.writeFile(outputPath.replace('.gif', '.png'), buffer);
        this.logger.info(
          `Created single frame image at ${outputPath.replace('.gif', '.png')}`
        );
      } else {
        // Save multiple frames
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, '.gif');

        for (let i = 0; i < canvases.length; i++) {
          const frameBuffer = canvases[i].toBuffer('image/png');
          const framePath = path.join(
            outputDir,
            `${baseName}_frame_${i.toString().padStart(3, '0')}.png`
          );
          await fs.writeFile(framePath, frameBuffer);
        }

        // Create a simple HTML file to display the frames
        const htmlContent = this.generateFrameViewer(
          canvases.length,
          baseName,
          duration
        );
        const htmlPath = outputPath.replace('.gif', '.html');
        await fs.writeFile(htmlPath, htmlContent);

        this.logger.info(
          `Created ${canvases.length} frames and viewer at ${htmlPath}`
        );
      }
    }

    return outputPath;
  }

  /**
   * Handle decoding Unicode escape sequences
   * Needed to render non-ASCII languages like Chinese or Arabic in the GIF overlay text
   */
  decodeUnicodeEscapes(text: string): string {
    if (!text.includes('\\u')) {
      return text;
    }

    try {
      return text.replace(/\\u[\dA-Fa-f]{4}/g, (match) => {
        const codePoint = parseInt(match.slice(2), 16);
        return String.fromCharCode(codePoint);
      });
    } catch (error) {
      this.logger.debug(`Failed to decode unicode escape sequences: ${text}`);
      return text;
    }
  }

  /**
   * Extract screenshots from agent history
   */
  private extractScreenshots(history: AgentHistory[]): (string | null)[] {
    return history.map((item) => {
      return item.state?.screenshot || null;
    });
  }

  /**
   * Load image from base64 string and return as Canvas
   */
  private async loadImageFromBase64(base64Data: string): Promise<Canvas> {
    const buffer = Buffer.from(base64Data, 'base64');
    const image = await loadImage(buffer);

    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);

    return canvas;
  }

  /**
   * Create initial frame showing the task
   */
  private async createTaskFrame(
    task: string,
    firstScreenshot: string,
    width: number,
    height: number,
    font: FontConfig,
    lineSpacing: number,
    showLogo: boolean
  ): Promise<Canvas> {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fill with black background
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);

    // Calculate vertical center
    const centerY = height / 2;

    // Dynamic font size calculation based on task length
    const margin = 140;
    const maxWidth = width - 2 * margin;

    const baseFontSize = font.size + 16;
    const minFontSize = Math.max(font.size - 10, 16);
    const textLength = task.length;

    let fontSize = baseFontSize;
    if (textLength > 200) {
      fontSize = Math.max(
        baseFontSize - Math.floor(10 * (textLength / 200)),
        minFontSize
      );
    }

    // Set font
    ctx.font = `${fontSize}px ${font.family}`;
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Wrap text and draw
    const wrappedText = this.wrapText(task, ctx, maxWidth);
    const lines = wrappedText.split('\\n');
    const lineHeight = fontSize * lineSpacing;
    const totalHeight = lineHeight * lines.length;

    let textY = centerY - totalHeight / 2 + 50;

    for (const line of lines) {
      ctx.fillText(line, width / 2, textY);
      textY += lineHeight;
    }

    // Add logo if requested (top right corner)
    if (showLogo) {
      try {
        // Load logo implementation would go here
        // const logo = await loadImage('./static/browser-use.png');
        // ctx.drawImage(logo, width - logo.width - 20, 20);
      } catch (error) {
        this.logger.warn(`Could not load logo: ${error}`);
      }
    }

    return canvas;
  }

  /**
   * Add step number and goal overlay to an image
   */
  private async addOverlayToImage(
    sourceCanvas: Canvas,
    stepNumber: number,
    goalText: string,
    options: {
      fontSize: number;
      titleFontSize: number;
      goalFontSize: number;
      margin: number;
      fontFamily: string;
    },
    showLogo: boolean
  ): Promise<Canvas> {
    const { fontSize, titleFontSize, goalFontSize, margin, fontFamily } =
      options;

    const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
    const ctx = canvas.getContext('2d');

    // Copy original image
    ctx.drawImage(sourceCanvas, 0, 0);

    // Decode Unicode escapes
    goalText = this.decodeUnicodeEscapes(goalText);

    // Add step number (bottom left)
    const stepText = stepNumber.toString();
    ctx.font = `${titleFontSize}px ${fontFamily}`;
    ctx.fillStyle = 'white';

    const stepMetrics = ctx.measureText(stepText);
    const stepWidth = stepMetrics.width;
    const stepHeight = titleFontSize;

    const xStep = margin + 10;
    const yStep = canvas.height - margin - stepHeight - 10;

    // Draw rounded rectangle background for step number
    const padding = 20;
    this.drawRoundedRect(
      ctx,
      xStep - padding,
      yStep - padding,
      stepWidth + 2 * padding,
      stepHeight + 2 * padding,
      15,
      'rgba(0, 0, 0, 0.8)'
    );

    // Draw step number
    ctx.fillStyle = 'white';
    ctx.fillText(stepText, xStep, yStep + stepHeight);

    // Draw goal text (centered, bottom)
    const maxWidth = canvas.width - 4 * margin;
    const wrappedGoal = this.wrapText(goalText, ctx, maxWidth);

    ctx.font = `${goalFontSize}px ${fontFamily}`;
    const goalMetrics = ctx.measureText(wrappedGoal);
    const goalWidth = goalMetrics.width;
    const goalHeight = goalFontSize;

    const xGoal = (canvas.width - goalWidth) / 2;
    const yGoal = yStep - goalHeight - padding * 4;

    // Draw rounded rectangle background for goal
    const goalPadding = 25;
    this.drawRoundedRect(
      ctx,
      xGoal - goalPadding,
      yGoal - goalPadding,
      goalWidth + 2 * goalPadding,
      goalHeight + 2 * goalPadding,
      15,
      'rgba(0, 0, 0, 0.8)'
    );

    // Draw goal text
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.fillText(wrappedGoal, canvas.width / 2, yGoal + goalHeight);

    return canvas;
  }

  /**
   * Wrap text to fit within a given width
   */
  private wrapText(
    text: string,
    ctx: CanvasRenderingContext2D,
    maxWidth: number
  ): string {
    text = this.decodeUnicodeEscapes(text);
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine: string[] = [];

    for (const word of words) {
      currentLine.push(word);
      const line = currentLine.join(' ');
      const metrics = ctx.measureText(line);

      if (metrics.width > maxWidth) {
        if (currentLine.length === 1) {
          // Single word is too long, add it anyway
          lines.push(currentLine.pop()!);
        } else {
          // Remove the last word and start new line
          currentLine.pop();
          lines.push(currentLine.join(' '));
          currentLine = [word];
        }
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine.join(' '));
    }

    return lines.join('\\n');
  }

  /**
   * Draw rounded rectangle
   */
  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fillStyle: string
  ): void {
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Generate HTML frame viewer for displaying the sequence
   */
  private generateFrameViewer(
    frameCount: number,
    baseName: string,
    duration: number
  ): string {
    const framePaths = Array.from(
      { length: frameCount },
      (_, i) => `${baseName}_frame_${i.toString().padStart(3, '0')}.png`
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent History Animation - ${baseName}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background: #1a1a1a;
            color: white;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .container {
            max-width: 100vw;
            text-align: center;
        }
        .frame {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        .controls {
            margin: 20px 0;
        }
        button {
            padding: 10px 20px;
            margin: 0 5px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
        }
        button:hover {
            background: #45a049;
        }
        button:disabled {
            background: #666;
            cursor: not-allowed;
        }
        .info {
            margin: 10px 0;
            color: #ccc;
        }
        .progress {
            width: 300px;
            height: 6px;
            background: #333;
            border-radius: 3px;
            margin: 10px auto;
            overflow: hidden;
        }
        .progress-bar {
            height: 100%;
            background: #4CAF50;
            border-radius: 3px;
            transition: width 0.1s ease;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Agent History Animation</h1>
        <div class="info">
            <p>Frame <span id="current-frame">1</span> of ${frameCount}</p>
            <div class="progress">
                <div class="progress-bar" id="progress-bar"></div>
            </div>
        </div>

        <img id="animation-frame" class="frame" src="${framePaths[0]}" alt="Animation frame">

        <div class="controls">
            <button id="play-pause">▶ Play</button>
            <button id="prev">⏮ Previous</button>
            <button id="next">⏭ Next</button>
            <button id="reset">⏹ Reset</button>
        </div>

        <div class="info">
            <p>Duration per frame: ${duration}ms</p>
            <p>Total frames: ${frameCount}</p>
        </div>
    </div>

    <script>
        const frames = ${JSON.stringify(framePaths)};
        const duration = ${duration};
        let currentFrame = 0;
        let isPlaying = false;
        let intervalId = null;

        const frameImg = document.getElementById('animation-frame');
        const currentFrameSpan = document.getElementById('current-frame');
        const progressBar = document.getElementById('progress-bar');
        const playPauseBtn = document.getElementById('play-pause');
        const prevBtn = document.getElementById('prev');
        const nextBtn = document.getElementById('next');
        const resetBtn = document.getElementById('reset');

        function updateFrame() {
            frameImg.src = frames[currentFrame];
            currentFrameSpan.textContent = currentFrame + 1;
            progressBar.style.width = ((currentFrame + 1) / frames.length * 100) + '%';
        }

        function play() {
            if (isPlaying) return;
            isPlaying = true;
            playPauseBtn.textContent = '⏸ Pause';

            intervalId = setInterval(() => {
                currentFrame = (currentFrame + 1) % frames.length;
                updateFrame();

                if (currentFrame === 0 && frames.length > 1) {
                    // Completed one loop, pause for a moment
                    pause();
                    setTimeout(() => {
                        if (!isPlaying) play(); // Resume if not manually paused
                    }, duration);
                }
            }, duration);
        }

        function pause() {
            isPlaying = false;
            playPauseBtn.textContent = '▶ Play';
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }
        }

        function next() {
            pause();
            currentFrame = (currentFrame + 1) % frames.length;
            updateFrame();
        }

        function prev() {
            pause();
            currentFrame = currentFrame === 0 ? frames.length - 1 : currentFrame - 1;
            updateFrame();
        }

        function reset() {
            pause();
            currentFrame = 0;
            updateFrame();
        }

        // Event listeners
        playPauseBtn.addEventListener('click', () => {
            if (isPlaying) pause();
            else play();
        });

        nextBtn.addEventListener('click', next);
        prevBtn.addEventListener('click', prev);
        resetBtn.addEventListener('click', reset);

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case ' ':
                case 'Enter':
                    e.preventDefault();
                    if (isPlaying) pause();
                    else play();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    next();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    prev();
                    break;
                case 'r':
                case 'R':
                    e.preventDefault();
                    reset();
                    break;
            }
        });

        // Initialize
        updateFrame();
    </script>
</body>
</html>`;
  }

  /**
   * Get preferred font family
   */
  private getPreferredFont(): string {
    return this.availableFonts.length > 0
      ? this.availableFonts[0]
      : 'Arial, sans-serif';
  }
}

// Export singleton instance
export const visualizationService = new VisualizationService();

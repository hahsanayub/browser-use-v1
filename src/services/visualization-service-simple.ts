/**
 * Simplified Visualization Service - Node.js Implementation
 *
 * A lightweight version that doesn't require canvas dependency
 * Focuses on text processing and HTML generation
 */

import fs from 'fs/promises';
import path from 'path';
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

export class SimplifiedVisualizationService {
  private logger: ReturnType<typeof getLogger>;

  constructor() {
    this.logger = getLogger();
  }

  /**
   * Generate operation history visualization (lightweight HTML version)
   *
   * @param task Task description text
   * @param history Agent history containing screenshots and actions
   * @param options Visualization generation options
   */
  async createHistoryVisualization(
    task: string,
    history: AgentHistory[],
    options: GifOptions = {}
  ): Promise<string> {
    const {
      outputPath = 'agent_history.html',
      duration = 3000,
      showGoals = true,
      showTask = true,
    } = options;

    if (!history.length) {
      this.logger.warn('No history to create visualization from');
      return outputPath;
    }

    // Extract screenshots and filter out placeholders
    const screenshots = this.extractValidScreenshots(history);

    if (!screenshots.length) {
      this.logger.warn('No valid screenshots found in history');
      return outputPath;
    }

    // Generate HTML visualization
    const htmlContent = this.generateVisualizationHTML(
      task,
      history,
      screenshots,
      {
        duration,
        showGoals,
        showTask,
      }
    );

    // Save HTML file
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outputPath, htmlContent);

    this.logger.info(`Created visualization at ${outputPath}`);
    return outputPath;
  }

  /**
   * Handle decoding Unicode escape sequences
   * Needed to render non-ASCII languages like Chinese or Arabic in the visualization
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
   * Extract valid screenshots from agent history, filtering out placeholders
   */
  private extractValidScreenshots(history: AgentHistory[]): Array<{
    screenshot: string;
    index: number;
    goal?: string;
    step: number;
  }> {
    const validScreenshots = [];

    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      const screenshot = item.state?.screenshot;

      if (screenshot && screenshot !== PLACEHOLDER_4PX_SCREENSHOT) {
        validScreenshots.push({
          screenshot,
          index: i,
          goal: item.model_output?.current_state?.next_goal,
          step: item.step,
        });
      }
    }

    return validScreenshots;
  }

  /**
   * Generate comprehensive HTML visualization
   */
  private generateVisualizationHTML(
    task: string,
    history: AgentHistory[],
    screenshots: Array<{
      screenshot: string;
      index: number;
      goal?: string;
      step: number;
    }>,
    options: {
      duration: number;
      showGoals: boolean;
      showTask: boolean;
    }
  ): string {
    const { duration, showGoals, showTask } = options;

    // Decode Unicode in task and goals
    const decodedTask = this.decodeUnicodeEscapes(task);
    const decodedScreenshots = screenshots.map((s) => ({
      ...s,
      goal: s.goal ? this.decodeUnicodeEscapes(s.goal) : undefined,
    }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent History Visualization</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: linear-gradient(135deg, #1a1a2e, #16213e);
            color: white;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 30px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }

        .task-title {
            font-size: 2.5em;
            font-weight: bold;
            margin-bottom: 20px;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .task-description {
            font-size: 1.2em;
            color: #ccc;
            max-width: 800px;
            margin: 0 auto;
            line-height: 1.6;
        }

        .visualization-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            margin-bottom: 40px;
        }

        .screenshot-display {
            max-width: 100%;
            max-height: 70vh;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
            margin-bottom: 30px;
            position: relative;
            overflow: hidden;
        }

        .screenshot-overlay {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            background: linear-gradient(transparent, rgba(0,0,0,0.8));
            padding: 30px;
            color: white;
        }

        .step-number {
            display: inline-block;
            background: #4CAF50;
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            margin-bottom: 10px;
            font-size: 0.9em;
        }

        .goal-text {
            font-size: 1.1em;
            line-height: 1.5;
            margin-top: 10px;
        }

        .controls {
            display: flex;
            gap: 15px;
            justify-content: center;
            flex-wrap: wrap;
            margin-bottom: 30px;
        }

        .control-button {
            padding: 12px 24px;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            color: white;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
        }

        .control-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(76, 175, 80, 0.4);
        }

        .control-button:active {
            transform: translateY(0);
        }

        .control-button:disabled {
            background: #666;
            cursor: not-allowed;
            box-shadow: none;
            transform: none;
        }

        .progress-container {
            width: 100%;
            max-width: 500px;
            margin: 20px auto;
        }

        .progress-info {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            font-size: 0.9em;
            color: #ccc;
        }

        .progress-bar-container {
            height: 8px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            overflow: hidden;
        }

        .progress-bar {
            height: 100%;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            border-radius: 4px;
            transition: width 0.3s ease;
        }

        .timeline {
            margin-top: 40px;
            padding: 30px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 15px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .timeline-title {
            font-size: 1.5em;
            margin-bottom: 20px;
            color: #4CAF50;
        }

        .timeline-item {
            display: flex;
            align-items: center;
            padding: 15px;
            margin-bottom: 10px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s ease;
            border-left: 4px solid transparent;
        }

        .timeline-item:hover {
            background: rgba(255, 255, 255, 0.15);
            border-left-color: #4CAF50;
        }

        .timeline-item.active {
            background: rgba(76, 175, 80, 0.2);
            border-left-color: #4CAF50;
        }

        .timeline-step {
            min-width: 40px;
            height: 40px;
            background: #4CAF50;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            margin-right: 15px;
        }

        .timeline-content {
            flex: 1;
        }

        .timeline-goal {
            font-size: 0.9em;
            color: #ddd;
            margin-top: 5px;
        }

        @media (max-width: 768px) {
            .controls {
                flex-direction: column;
                align-items: center;
            }

            .control-button {
                width: 200px;
            }

            .task-title {
                font-size: 2em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        ${
          showTask
            ? `
        <div class="header">
            <h1 class="task-title">Agent Task</h1>
            <p class="task-description">${decodedTask}</p>
        </div>
        `
            : ''
        }

        <div class="visualization-container">
            <img id="current-screenshot" class="screenshot-display" src="data:image/png;base64,${decodedScreenshots[0].screenshot}" alt="Agent screenshot">

            ${
              showGoals
                ? `
            <div class="screenshot-overlay" id="screenshot-overlay">
                <div class="step-number" id="step-number">Step ${decodedScreenshots[0].step}</div>
                <div class="goal-text" id="goal-text">${decodedScreenshots[0].goal || 'No goal specified'}</div>
            </div>
            `
                : ''
            }

            <!-- Hidden screenshots for testing and preloading -->
            ${decodedScreenshots.map((s, index) =>
              `<img style="display: none;" src="data:image/png;base64,${s.screenshot}" alt="Screenshot ${index + 1}" />`
            ).join('')}
        </div>

        <div class="controls">
            <button class="control-button" id="play-pause">▶ Play</button>
            <button class="control-button" id="prev">⏮ Previous</button>
            <button class="control-button" id="next">⏭ Next</button>
            <button class="control-button" id="reset">⏹ Reset</button>
        </div>

        <div class="progress-container">
            <div class="progress-info">
                <span id="current-info">Step 1 of ${decodedScreenshots.length}</span>
                <span>Duration: ${duration}ms</span>
            </div>
            <div class="progress-bar-container">
                <div class="progress-bar" id="progress-bar"></div>
            </div>
        </div>

        <div class="timeline">
            <h2 class="timeline-title">Execution Timeline</h2>
            ${decodedScreenshots
              .map(
                (screenshot, index) => `
                <div class="timeline-item ${index === 0 ? 'active' : ''}" data-index="${index}">
                    <div class="timeline-step">${screenshot.step}</div>
                    <div class="timeline-content">
                        <div>Step ${screenshot.step}: ${history[screenshot.index].action.action || 'Action'}</div>
                        ${screenshot.goal ? `<div class="timeline-goal">${screenshot.goal}</div>` : ''}
                    </div>
                </div>
            `
              )
              .join('')}
        </div>
    </div>

    <script>
        const screenshots = ${JSON.stringify(decodedScreenshots)};
        const duration = ${duration};
        let currentIndex = 0;
        let isPlaying = false;
        let intervalId = null;

        // DOM elements
        const currentScreenshot = document.getElementById('current-screenshot');
        const stepNumber = document.getElementById('step-number');
        const goalText = document.getElementById('goal-text');
        const currentInfo = document.getElementById('current-info');
        const progressBar = document.getElementById('progress-bar');
        const playPauseBtn = document.getElementById('play-pause');
        const prevBtn = document.getElementById('prev');
        const nextBtn = document.getElementById('next');
        const resetBtn = document.getElementById('reset');
        const timelineItems = document.querySelectorAll('.timeline-item');

        function updateDisplay() {
            const screenshot = screenshots[currentIndex];

            currentScreenshot.src = 'data:image/png;base64,' + screenshot.screenshot;

            if (stepNumber) {
                stepNumber.textContent = 'Step ' + screenshot.step;
            }

            if (goalText) {
                goalText.textContent = screenshot.goal || 'No goal specified';
            }

            currentInfo.textContent = \`Step \${currentIndex + 1} of \${screenshots.length}\`;
            progressBar.style.width = ((currentIndex + 1) / screenshots.length * 100) + '%';

            // Update timeline
            timelineItems.forEach((item, index) => {
                item.classList.toggle('active', index === currentIndex);
            });
        }

        function play() {
            if (isPlaying) return;
            isPlaying = true;
            playPauseBtn.textContent = '⏸ Pause';

            intervalId = setInterval(() => {
                currentIndex = (currentIndex + 1) % screenshots.length;
                updateDisplay();

                if (currentIndex === 0 && screenshots.length > 1) {
                    pause();
                    setTimeout(() => {
                        if (!isPlaying) play();
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
            currentIndex = (currentIndex + 1) % screenshots.length;
            updateDisplay();
        }

        function prev() {
            pause();
            currentIndex = currentIndex === 0 ? screenshots.length - 1 : currentIndex - 1;
            updateDisplay();
        }

        function reset() {
            pause();
            currentIndex = 0;
            updateDisplay();
        }

        function goToStep(index) {
            pause();
            currentIndex = index;
            updateDisplay();
        }

        // Event listeners
        playPauseBtn.addEventListener('click', () => {
            if (isPlaying) pause();
            else play();
        });

        prevBtn.addEventListener('click', prev);
        nextBtn.addEventListener('click', next);
        resetBtn.addEventListener('click', reset);

        // Timeline click handlers
        timelineItems.forEach((item, index) => {
            item.addEventListener('click', () => goToStep(index));
        });

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
        updateDisplay();
    </script>
</body>
</html>`;
  }
}

// Export factory function to create service after logger initialization
export function createSimplifiedVisualizationService(): SimplifiedVisualizationService {
  return new SimplifiedVisualizationService();
}

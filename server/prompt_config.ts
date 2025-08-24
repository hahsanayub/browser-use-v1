import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PromptConfig {
  private promptFilePath: string;

  constructor() {
    // Store the file paths for dynamic reading
    this.promptFilePath = path.join(__dirname, 'browser_prompt.md');
  }

  /**
   * Return the complete extend prompt message from the browser_prompt.md file
   */
  get extendPromptMessage(): string {
    try {
      console.log(`Reading extend prompt file: ${this.promptFilePath}`);
      return fs.readFileSync(this.promptFilePath, 'utf-8');
    } catch (error) {
      console.error(`Error reading browser_prompt.md: ${error}`);
      throw new Error(`Failed to read browser_prompt.md: ${error}`);
    }
  }

}

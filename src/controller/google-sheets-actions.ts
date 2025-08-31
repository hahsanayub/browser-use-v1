/**
 * Google Sheets Actions - Node.js Implementation
 *
 * Features:
 * - Read entire sheet contents
 * - Read specific cell/range contents
 * - Update cell/range contents
 * - Clear cell/range contents
 * - Select cell/range
 * - Fallback input method
 */

import { z } from 'zod';
import type { Page } from 'playwright';
import { action } from './decorators';
import type { ActionResult } from '../types/agent';
import { withHealthCheck } from '../services/health-check';

/**
 * Helper function to check if page is Google Sheets
 */
function isGoogleSheetsPage(page: Page): boolean {
  return page.url().includes('docs.google.com/spreadsheets');
}

/**
 * Google Sheets Actions Class
 * Contains all Google Sheets specific automation actions
 */
class GoogleSheetsActions {
  /**
   * Read the contents of the entire sheet
   */
  @action(
    'read_sheet_contents',
    'Google Sheets: Get the contents of the entire sheet',
    z.object({}),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async readSheetContents({
    page,
  }: {
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        // Select all cells using keyboard shortcuts
        await p.keyboard.press('Enter'); // Ensure we're not in edit mode
        await p.keyboard.press('Escape'); // Clear any current focus
        await p.keyboard.press('Meta+A'); // Select all (Ctrl+A on Windows, Cmd+A on Mac)
        await p.keyboard.press('Meta+C'); // Copy selection

        // Read from clipboard
        const extractedTsv = await p.evaluate(() =>
          navigator.clipboard.readText()
        );

        const message = 'Retrieved sheet contents';
        console.log(`📊 ${message}`);

        return {
          success: true,
          message,
          extractedContent: extractedTsv,
        };
      } catch (error) {
        const errorMessage = `Failed to read sheet contents: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Select a specific cell or range of cells
   */
  @action(
    'select_cell_or_range',
    'Google Sheets: Select a specific cell or range of cells',
    z.object({
      cell_or_range: z
        .string()
        .min(1)
        .describe('Cell reference like A1 or range like A1:B2'),
    }),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async selectCellOrRange({
    params,
    page,
  }: {
    params: { cell_or_range: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        const { cell_or_range } = params;

        // Ensure we're not in edit mode and clear any current selection
        await p.keyboard.press('Enter'); // Exit edit mode if we were editing
        await p.keyboard.press('Escape'); // Clear current focus
        await p.waitForTimeout(100); // Small delay for UI to update

        // Move to top-left to establish a known starting position
        await p.keyboard.press('Home'); // Move to beginning of current row
        await p.keyboard.press('ArrowUp'); // Move up one cell
        await p.waitForTimeout(100);

        // Open "Go to range" dialog
        await p.keyboard.press('Control+G'); // Ctrl+G opens "Go to range"
        await p.waitForTimeout(200); // Wait for dialog to appear

        // Type the cell range
        await p.keyboard.type(cell_or_range, { delay: 50 });
        await p.waitForTimeout(200);

        // Confirm selection
        await p.keyboard.press('Enter');
        await p.waitForTimeout(200);

        // Close dialog in case it's still open
        await p.keyboard.press('Escape');

        const message = `Selected cells: ${cell_or_range}`;
        console.log(`🎯 ${message}`);

        return {
          success: true,
          message,
        };
      } catch (error) {
        const errorMessage = `Failed to select cells ${params.cell_or_range}: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Get the contents of a cell or range of cells
   */
  @action(
    'read_cell_contents',
    'Google Sheets: Get the contents of a cell or range of cells',
    z.object({
      cell_or_range: z
        .string()
        .min(1)
        .describe('Cell reference like A1 or range like A1:B2'),
    }),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async readCellContents({
    params,
    page,
  }: {
    params: { cell_or_range: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        const { cell_or_range } = params;

        // First select the cell/range
        await GoogleSheetsActions.selectCellOrRange({
          params: { cell_or_range },
          page: p,
        });

        // Copy the selection
        await p.keyboard.press('Meta+C'); // Copy
        await p.waitForTimeout(100); // Wait for copy to complete

        // Read from clipboard
        const extractedTsv = await p.evaluate(() =>
          navigator.clipboard.readText()
        );

        const message = `Retrieved contents from ${cell_or_range}`;
        console.log(`📖 ${message}`);

        return {
          success: true,
          message,
          extractedContent: extractedTsv,
        };
      } catch (error) {
        const errorMessage = `Failed to read cell contents ${params.cell_or_range}: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Update the content of a cell or range of cells
   */
  @action(
    'update_cell_contents',
    'Google Sheets: Update the content of a cell or range of cells',
    z.object({
      cell_or_range: z
        .string()
        .min(1)
        .describe('Cell reference like A1 or range like A1:B2'),
      new_contents_tsv: z
        .string()
        .describe('New content in TSV (Tab-Separated Values) format'),
    }),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async updateCellContents({
    params,
    page,
  }: {
    params: { cell_or_range: string; new_contents_tsv: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        const { cell_or_range, new_contents_tsv } = params;

        // First select the cell/range
        await GoogleSheetsActions.selectCellOrRange({
          params: { cell_or_range },
          page: p,
        });

        // Simulate paste event with new content
        await p.evaluate((content) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', content);

          // Get the currently focused element
          const activeElement = document.activeElement;
          if (activeElement) {
            // Dispatch paste event
            const pasteEvent = new ClipboardEvent('paste', {
              clipboardData,
              bubbles: true,
              cancelable: true,
            });
            activeElement.dispatchEvent(pasteEvent);
          }
        }, new_contents_tsv);

        const message = `Updated cells: ${cell_or_range} = ${new_contents_tsv}`;
        console.log(`✏️ ${message}`);

        return {
          success: true,
          message,
        };
      } catch (error) {
        const errorMessage = `Failed to update cell contents ${params.cell_or_range}: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Clear the contents of selected cells
   */
  @action(
    'clear_cell_contents',
    'Google Sheets: Clear the contents of a cell or range of cells',
    z.object({
      cell_or_range: z
        .string()
        .min(1)
        .describe('Cell reference like A1 or range like A1:B2'),
    }),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async clearCellContents({
    params,
    page,
  }: {
    params: { cell_or_range: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        const { cell_or_range } = params;

        // First select the cell/range
        await GoogleSheetsActions.selectCellOrRange({
          params: { cell_or_range },
          page: p,
        });

        // Clear contents using Backspace
        await p.keyboard.press('Backspace');

        const message = `Cleared cells: ${cell_or_range}`;
        console.log(`🗑️ ${message}`);

        return {
          success: true,
          message,
        };
      } catch (error) {
        const errorMessage = `Failed to clear cell contents ${params.cell_or_range}: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Fallback method to type text into currently selected cell
   */
  @action(
    'fallback_input_into_single_selected_cell',
    'Google Sheets: Fallback method to type text into (only one) currently selected cell',
    z.object({
      text: z
        .string()
        .min(1)
        .describe('Text to type into the currently selected cell'),
    }),
    {
      domains: ['https://docs.google.com'],
      isAvailableForPage: (page) =>
        page && !page.isClosed() && isGoogleSheetsPage(page),
    }
  )
  static async fallbackInputIntoSingleSelectedCell({
    params,
    page,
  }: {
    params: { text: string };
    page: Page;
  }): Promise<ActionResult> {
    return withHealthCheck(page, async (p) => {
      try {
        const { text } = params;

        // Type the text with small delay between characters
        await p.keyboard.type(text, { delay: 100 });

        // Commit the input and move cursor
        await p.keyboard.press('Enter'); // Commit the input
        await p.keyboard.press('ArrowUp'); // Move back to the cell we just edited

        const message = `Inputted text: ${text}`;
        console.log(`⌨️ ${message}`);

        return {
          success: true,
          message,
        };
      } catch (error) {
        const errorMessage = `Failed to input text into selected cell: ${(error as Error).message}`;
        console.error(errorMessage);
        throw new Error(errorMessage);
      }
    });
  }
}

// Export the actions class
export default GoogleSheetsActions;

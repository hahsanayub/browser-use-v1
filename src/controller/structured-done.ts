/**
 * Structured Done Action implementation for type-safe output
 */

import { z } from 'zod';
import { action } from './decorators';
import type { ActionResult } from '../types/agent';
import type { FileSystem } from '../services/file-system';
import { registry } from './singleton';

/**
 * Base model for structured output done action
 */
export interface StructuredDoneParams<T = any> {
  success: boolean;
  data: T;
}

/**
 * Factory to create a structured done action with a specific output model
 * This allows the agent to return type-safe structured data
 *
 * @param outputModel - Zod schema defining the structure of the output data
 * @param displayFilesInDoneText - Whether to include file contents in the response
 * @returns A function that registers the structured done action
 */
export function createStructuredDoneAction<T extends z.ZodTypeAny>(
  outputModel: T,
  displayFilesInDoneText: boolean = true
) {
  // Create a composite schema that includes success and the data model
  const StructuredOutputSchema = z.object({
    success: z.boolean().describe('Whether the task completed successfully'),
    data: outputModel,
  });

  // Define the action handler
  const structuredDoneHandler = async ({
    params,
    context,
  }: {
    params: z.infer<typeof StructuredOutputSchema>;
    context: { fileSystem?: FileSystem };
  }): Promise<ActionResult> => {
    const outputData = params.data;
    const outputJson = JSON.stringify(outputData, null, 2);

    // Build response message
    let message = `Task completed. Success Status: ${params.success}\n\nStructured Output:\n${outputJson}`;

    // Handle file display if FileSystem is available and files_to_display exists in data
    const attachments: string[] = [];
    if (
      context.fileSystem &&
      displayFilesInDoneText &&
      outputData &&
      typeof outputData === 'object' &&
      'files_to_display' in outputData &&
      Array.isArray(outputData.files_to_display)
    ) {
      const filesToDisplay = outputData.files_to_display as string[];

      for (const fileName of filesToDisplay) {
        if (fileName === 'todo.md') continue; // Skip todo file

        try {
          // Note: FileSystem's displayFile method would need to be implemented
          // For now, we'll just add to attachments
          attachments.push(fileName);
        } catch (error) {
          console.warn(`Failed to display file ${fileName}:`, error);
        }
      }
    }

    return {
      success: params.success,
      message,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        structuredOutput: outputData,
        isStructured: true,
      },
    };
  };

  // Register the action with the registry
  const registerStructuredDone = () => {
    // First, unregister any existing 'done' action
    if (registry.has('done')) {
      registry.unregister('done');
    }

    // Create description for the structured done action
    const description = `Complete task - with return data matching the required schema and if the task is finished (success=True) or not yet completely finished (success=False), because last step is reached`;

    // Directly register the action without decorator
    registry.register({
      name: 'done',
      description,
      paramSchema: StructuredOutputSchema,
      execute: async ({ params, context }) => {
        return structuredDoneHandler({
          params: params as z.infer<typeof StructuredOutputSchema>,
          context,
        });
      },
      promptDescription: () => {
        let s = `${description}: \n`;
        s += `{done: `;
        try {
          const schemaObj: any = {};
          schemaObj.success = {
            type: 'boolean',
            description: 'Whether the task completed successfully',
          };
          schemaObj.data = {
            type: 'object',
            description: 'Output data matching the required schema',
          };
          s += JSON.stringify(schemaObj);
        } catch {
          s += '{}';
        }
        s += '}';
        return s;
      },
    });
  };

  registerStructuredDone();
}

/**
 * Helper function to use structured output in Controller
 */
export function useStructuredOutputAction<T extends z.ZodTypeAny>(
  outputModel: T,
  displayFilesInDoneText: boolean = true
): void {
  createStructuredDoneAction(outputModel, displayFilesInDoneText);
}

/**
 * Reset to default done action (non-structured)
 * This allows switching back to the regular text-based done action
 */
export function resetToDefaultDoneAction(): void {
  // Unregister structured done if it exists
  if (registry.has('done')) {
    registry.unregister('done');
  }

  // Re-register the default done action
  // This will be picked up from the main actions.ts file
  // which should auto-register when imported
}

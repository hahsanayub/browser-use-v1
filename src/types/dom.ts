/**
 * DOM-related type definitions
 */

export interface InteractiveElement {
  /** Unique identifier for the element */
  id: string;
  /** Tag name of the element */
  tagName: string;
  /** Element type (button, input, link, etc.) */
  type: string;
  /** Text content of the element */
  text?: string;
  /** Element attributes */
  attributes: Record<string, string>;
  /** CSS selector to locate the element */
  selector: string;
  /** Bounding box coordinates */
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface PageView {
  /** Simplified HTML content */
  html: string;
  /** List of interactive elements */
  interactiveElements: InteractiveElement[];
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** Page loading state */
  isLoading: boolean;
  /** Viewport information */
  viewport: {
    width: number;
    height: number;
  };
  /** Timestamp when the view was captured */
  timestamp: number;
}

export interface DOMProcessingOptions {
  /** Whether to remove script tags */
  removeScripts?: boolean;
  /** Whether to remove style tags */
  removeStyles?: boolean;
  /** Whether to remove comments */
  removeComments?: boolean;
  /** Whether to mark interactive elements */
  markInteractive?: boolean;
  /** Maximum text length for elements */
  maxTextLength?: number;
  /** Whether to include hidden elements */
  includeHidden?: boolean;
}

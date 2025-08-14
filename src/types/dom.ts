/**
 * DOM-related type definitions
 */

export interface ViewportInfo {
  width: number;
  height: number;
}

export interface DOMBaseNode {
  isVisible: boolean;
  parent: DOMElementNode | null;
  type?: string; // Add type property to base node
}

export interface DOMTextNode extends DOMBaseNode {
  text: string;
  type: 'TEXT_NODE';
}

export interface DOMElementNode extends DOMBaseNode {
  tagName: string;
  xpath: string;
  attributes: Record<string, string>;
  children: DOMBaseNode[];
  isInteractive: boolean;
  isTopElement: boolean;
  isInViewport: boolean;
  shadowRoot: boolean;
  highlightIndex: number | null;
  viewportInfo: ViewportInfo | null;
}

export type SelectorMap = Record<number, DOMElementNode>;

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
  /** Optional raw DOM state structure for advanced reasoning */
  domState?: DOMState;
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

/**
 * Raw DOM state captured from in-page buildDomTree.js.
 * Fields are best-effort and may vary across sites.
 */
export interface DOMState {
  /** Tree structure representing the page (if available) */
  elementTree?: DOMElementNode;
  /** Node map keyed by internal id */
  map: Record<string, InteractiveElement>;
  /** CSS/XPath selector map keyed by internal id */
  selectorMap: Record<string, string>;
}

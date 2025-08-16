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

export interface PageInfo {
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
  scrollX: number;
  scrollY: number;
  pixelsAbove: number;
  pixelsBelow: number;
  pixelsLeft: number;
  pixelsRight: number;
}

export interface TabsInfo {
  pageId: number;
  url: string;
  title: string;
  parentPageId: number | null;
}

export interface PageView {
  /** Simplified HTML content */
  html: string;
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** Page loading state */
  isLoading: boolean; // todo: implement loading_status
  /** Timestamp when the view was captured */
  timestamp: number;
  /** Optional raw DOM state structure for advanced reasoning */
  domState?: DOMState;
  /** Page information */
  pageInfo: PageInfo;
  /** Tabs information */
  tabsInfo: TabsInfo[];
  /** Browser errors */
  browserErrors: string[];
  // /** Whether the page is a PDF viewer */
  // isPdfViewer: boolean;
  // /** Screenshot */
  // screenshot: string;
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
  map: Record<string, DOMNode>;
  /** CSS/XPath selector map keyed by internal id */
  selectorMap: Record<string, string>;
}

export interface DOMNode {
  tagName: string;
  isVisible: boolean;
  attributes?: Record<string, string>;
  xpath?: string;
  children?: string[];
  isTopElement?: boolean;
  isInteractive?: boolean;
  isInViewport?: boolean;
  highlightIndex?: number;
  shadowRoot?: boolean;
  text?: string;
  type?: string;
}

export type DOMResult = {
  rootId: string;
  map: Record<string, DOMNode>;
};

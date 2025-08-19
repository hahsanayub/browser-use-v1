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
  /** Whether the page is a PDF viewer */
  isPdfViewer: boolean;
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
  /** Viewport expansion in pixels (-1 for all elements) */
  viewportExpansion?: number;
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

// Bounding box and serialization types
export interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PropagatingBounds {
  tag: string;
  bounds: DOMRect;
  nodeId: number;
  depth: number;
}

export interface PropagatingElement {
  tag: string;
  role: string | null;
}

export interface SimplifiedNode {
  originalNode: EnhancedDOMTreeNode;
  children: SimplifiedNode[];
  interactiveIndex?: number;
  isNew?: boolean;
  excludedByParent?: boolean;
  shouldDisplay?: boolean;
}

export interface EnhancedDOMTreeNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: NodeType;
  nodeName: string;
  tagName: string;
  nodeValue?: string;
  attributes?: Record<string, string>;
  children: EnhancedDOMTreeNode[];
  childrenAndShadowRoots: EnhancedDOMTreeNode[];
  contentDocument?: EnhancedDOMTreeNode;
  snapShotNode?: SnapshotNode;
  isVisible: boolean;
  isActuallyScrollable: boolean;
  isScrollable: boolean;
  shouldShowScrollInfo: boolean;
  elementIndex?: number;
  axNode?: AccessibilityNode;
}

export interface SnapshotNode {
  bounds?: DOMRect;
}

export interface AccessibilityNode {
  role?: string;
  properties?: AccessibilityProperty[];
}

export interface AccessibilityProperty {
  name: string;
  value: any;
}

export enum NodeType {
  ELEMENT_NODE = 1,
  TEXT_NODE = 3,
  DOCUMENT_NODE = 9,
  DOCUMENT_FRAGMENT_NODE = 11,
}

export interface SerializedDOMState {
  root?: SimplifiedNode;
  selectorMap: DOMSelectorMap;
}

export type DOMSelectorMap = Record<number, EnhancedDOMTreeNode>;

export interface TimingInfo {
  createSimplifiedTree?: number;
  optimizeTree?: number;
  bboxFiltering?: number;
  assignInteractiveIndices?: number;
  clickableDetectionTime?: number;
  serializeAccessibleElementsTotal?: number;
}

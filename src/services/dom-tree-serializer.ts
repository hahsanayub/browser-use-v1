/**
 * DOM Tree Serializer - Serializes enhanced DOM trees to string format for LLM consumption
 */
import { getLogger } from './logging';
import { ClickableElementDetector } from './clickable-element-detector';
import type {
  EnhancedDOMTreeNode,
  SimplifiedNode,
  PropagatingElement,
  PropagatingBounds,
  SerializedDOMState,
  DOMSelectorMap,
  TimingInfo,
  DOMRect,
  DOMElementNode,
  DOMBaseNode,
  DOMTextNode,
} from '../types/dom';

const DISABLED_ELEMENTS = new Set([
  'style',
  'script',
  'head',
  'meta',
  'link',
  'title',
]);

/**
 * Default attributes to include in serialization - matches Python version exactly
 */
export const DEFAULT_INCLUDE_ATTRIBUTES = [
  'title',
  'type',
  'checked',
  'name',
  'role',
  'value',
  'placeholder',
  'data-date-format',
  'alt',
  'aria-label',
  'aria-expanded',
  'data-state',
  'aria-checked',
];

export interface SimplifiedDOMOptions {
  /** Maximum total length of the elements string */
  maxTotalLength: number;
}

/**
 * Serializes enhanced DOM trees to string format.
 */
export class DOMTreeSerializer {
  private logger = getLogger();
  private interactiveCounter = 1;
  private selectorMap: DOMSelectorMap = {};
  private previousCachedSelectorMap?: DOMSelectorMap;
  private timingInfo: TimingInfo = {};
  private clickableCache: Map<number, boolean> = new Map();

  // Configuration - elements that propagate bounds to their children
  private static readonly PROPAGATING_ELEMENTS: PropagatingElement[] = [
    { tag: 'a', role: null }, // <a> tag
    { tag: 'button', role: null }, // <button> tag
    { tag: 'div', role: 'button' }, // <div role="button">
    { tag: 'div', role: 'combobox' }, // <div role="combobox"> - dropdowns/selects
    { tag: 'span', role: 'button' }, // <span role="button">
    { tag: 'span', role: 'combobox' }, // <span role="combobox">
    { tag: 'input', role: 'combobox' }, // <input role="combobox"> - autocomplete inputs
    { tag: 'input', role: 'combobox' }, // <input type="text"> - text inputs with suggestions
    // {'tag': 'div', 'role': 'link'},     // <div role="link">
    // {'tag': 'span', 'role': 'link'},    // <span role="link">
  ];

  private static readonly DEFAULT_CONTAINMENT_THRESHOLD = 0.99; // 99% containment by default

  constructor(
    private rootNode: EnhancedDOMTreeNode,
    private previousCachedState?: SerializedDOMState,
    private enableBboxFiltering = true,
    private containmentThreshold = DOMTreeSerializer.DEFAULT_CONTAINMENT_THRESHOLD
  ) {
    this.previousCachedSelectorMap = previousCachedState?.selectorMap;
  }

  /**
   * Main serialization method
   */
  serializeAccessibleElements(): {
    state: SerializedDOMState;
    timing: TimingInfo;
  } {
    const startTotal = performance.now();

    // Reset state
    this.interactiveCounter = 1;
    this.selectorMap = {};
    this.clickableCache.clear();

    // Step 1: Create simplified tree (includes clickable element detection)
    const startStep1 = performance.now();
    const simplifiedTree = this.createSimplifiedTree(this.rootNode);
    const endStep1 = performance.now();
    this.timingInfo.createSimplifiedTree = endStep1 - startStep1;

    // Step 2: Optimize tree (remove unnecessary parents)
    const startStep2 = performance.now();
    const optimizedTree = this.optimizeTree(simplifiedTree);
    const endStep2 = performance.now();
    this.timingInfo.optimizeTree = endStep2 - startStep2;

    // Step 3: Apply bounding box filtering
    let filteredTree = optimizedTree;
    if (this.enableBboxFiltering && optimizedTree) {
      const startStep3 = performance.now();
      filteredTree = this.applyBoundingBoxFiltering(optimizedTree);
      const endStep3 = performance.now();
      this.timingInfo.bboxFiltering = endStep3 - startStep3;
    }

    // Step 4: Assign interactive indices to clickable elements
    const startStep4 = performance.now();
    this.assignInteractiveIndicesAndMarkNewNodes(filteredTree);
    const endStep4 = performance.now();
    this.timingInfo.assignInteractiveIndices = endStep4 - startStep4;

    const endTotal = performance.now();
    this.timingInfo.serializeAccessibleElementsTotal = endTotal - startTotal;

    return {
      state: {
        root: filteredTree || undefined,
        selectorMap: this.selectorMap,
      },
      timing: this.timingInfo,
    };
  }

  /**
   * Cached version of clickable element detection to avoid redundant calls
   */
  private isInteractiveCached(node: EnhancedDOMTreeNode): boolean {
    if (!this.clickableCache.has(node.nodeId)) {
      const startTime = performance.now();
      const result = this.isInteractive(node);
      const endTime = performance.now();

      if (!this.timingInfo.clickableDetectionTime) {
        this.timingInfo.clickableDetectionTime = 0;
      }
      this.timingInfo.clickableDetectionTime += endTime - startTime;

      this.clickableCache.set(node.nodeId, result);
    }

    return this.clickableCache.get(node.nodeId)!;
  }

  /**
   * Check if an element is interactive using enhanced detection
   */
  private isInteractive(node: EnhancedDOMTreeNode): boolean {
    return ClickableElementDetector.isInteractive(node);
  }

  /**
   * Step 1: Create a simplified tree with enhanced element detection
   */
  private createSimplifiedTree(
    node: EnhancedDOMTreeNode
  ): SimplifiedNode | null {
    if (node.nodeType === 9 /* NodeType.DOCUMENT_NODE */) {
      // For all children including shadow roots
      for (const child of node.childrenAndShadowRoots) {
        const simplifiedChild = this.createSimplifiedTree(child);
        if (simplifiedChild) {
          return simplifiedChild;
        }
      }
      return null;
    }

    if (node.nodeType === 11 /* NodeType.DOCUMENT_FRAGMENT_NODE */) {
      // Super simple pass-through for shadow DOM elements
      const simplified: SimplifiedNode = { originalNode: node, children: [] };
      for (const child of node.childrenAndShadowRoots) {
        const simplifiedChild = this.createSimplifiedTree(child);
        if (simplifiedChild) {
          simplified.children.push(simplifiedChild);
        }
      }
      return simplified;
    }

    if (node.nodeType === 1 /* NodeType.ELEMENT_NODE */) {
      // Skip non-content elements
      if (DISABLED_ELEMENTS.has(node.nodeName.toLowerCase())) {
        return null;
      }

      if (node.nodeName === 'IFRAME') {
        if (node.contentDocument) {
          const simplified: SimplifiedNode = {
            originalNode: node,
            children: [],
          };
          for (const child of node.contentDocument.children) {
            const simplifiedChild = this.createSimplifiedTree(child);
            if (simplifiedChild) {
              simplified.children.push(simplifiedChild);
            }
          }
          return simplified;
        }
      }

      // Use enhanced scoring for inclusion decision
      const isInteractive = this.isInteractiveCached(node);
      const isVisible = node.snapShotNode && node.isVisible;
      const isScrollable = node.isActuallyScrollable;

      // Include if interactive (regardless of visibility), or scrollable, or has children to process
      const shouldInclude =
        (isInteractive && isVisible) ||
        isScrollable ||
        node.childrenAndShadowRoots.length > 0;

      if (shouldInclude) {
        const simplified: SimplifiedNode = { originalNode: node, children: [] };

        // Process children
        for (const child of node.childrenAndShadowRoots) {
          const simplifiedChild = this.createSimplifiedTree(child);
          if (simplifiedChild) {
            simplified.children.push(simplifiedChild);
          }
        }

        // Return if meaningful or has meaningful children
        if (
          (isInteractive && isVisible) ||
          isScrollable ||
          simplified.children.length > 0
        ) {
          return simplified;
        }
      }
    }

    if (node.nodeType === 3 /* NodeType.TEXT_NODE */) {
      // Include meaningful text nodes
      const isVisible = node.snapShotNode && node.isVisible;
      if (
        isVisible &&
        node.nodeValue &&
        node.nodeValue.trim() &&
        node.nodeValue.trim().length > 1
      ) {
        return { originalNode: node, children: [] };
      }
    }

    return null;
  }

  /**
   * Step 2: Optimize tree structure
   */
  private optimizeTree(node: SimplifiedNode | null): SimplifiedNode | null {
    if (!node) {
      return null;
    }

    // Process children
    const optimizedChildren: SimplifiedNode[] = [];
    for (const child of node.children) {
      const optimizedChild = this.optimizeTree(child);
      if (optimizedChild) {
        optimizedChildren.push(optimizedChild);
      }
    }

    node.children = optimizedChildren;

    // Keep meaningful nodes
    const isInteractiveOpt = this.isInteractiveCached(node.originalNode);
    const isVisible =
      node.originalNode.snapShotNode && node.originalNode.isVisible;

    if (
      (isInteractiveOpt && isVisible) || // Only keep interactive nodes that are visible
      node.originalNode.isActuallyScrollable ||
      node.originalNode.nodeType === 3 /* NodeType.TEXT_NODE */ ||
      node.children.length > 0
    ) {
      return node;
    }

    return null;
  }

  /**
   * Filter children contained within propagating parent bounds
   */
  private applyBoundingBoxFiltering(
    node: SimplifiedNode | null
  ): SimplifiedNode | null {
    if (!node) {
      return null;
    }

    // Start with no active bounds
    this.filterTreeRecursive(node, undefined, 0);

    // Log statistics
    const excludedCount = this.countExcludedNodes(node);
    if (excludedCount > 0) {
      this.logger.debug(`BBox filtering excluded ${excludedCount} nodes`);
    }

    return node;
  }

  /**
   * Recursively filter tree with bounding box propagation
   */
  private filterTreeRecursive(
    node: SimplifiedNode,
    activeBounds?: PropagatingBounds,
    depth = 0
  ): void {
    // Check if this node should be excluded by active bounds
    if (activeBounds && this.shouldExcludeChild(node, activeBounds)) {
      node.excludedByParent = true;
    }

    // Check if this node starts new propagation (even if excluded!)
    let newBounds: PropagatingBounds | undefined;
    const tag = node.originalNode.tagName.toLowerCase();
    const role = node.originalNode.attributes?.role;
    const attributes = { tag, role };

    // Check if this element matches any propagating element pattern
    if (this.isPropagatingElement(attributes)) {
      // This node propagates bounds to ALL its descendants
      if (node.originalNode.snapShotNode?.bounds) {
        newBounds = {
          tag,
          bounds: node.originalNode.snapShotNode.bounds,
          nodeId: node.originalNode.nodeId,
          depth,
        };
      }
    }

    // Propagate to ALL children
    // Use new_bounds if this node starts propagation, otherwise continue with active_bounds
    const propagateBounds = newBounds || activeBounds;

    for (const child of node.children) {
      this.filterTreeRecursive(child, propagateBounds, depth + 1);
    }
  }

  /**
   * Determine if child should be excluded based on propagating bounds
   */
  private shouldExcludeChild(
    node: SimplifiedNode,
    activeBounds: PropagatingBounds
  ): boolean {
    // Never exclude text nodes - we always want to preserve text content
    if (node.originalNode.nodeType === 3 /* NodeType.TEXT_NODE */) {
      return false;
    }

    // Get child bounds
    if (!node.originalNode.snapShotNode?.bounds) {
      return false; // No bounds = can't determine containment
    }

    const childBounds = node.originalNode.snapShotNode.bounds;

    // Check containment with configured threshold
    if (
      !this.isContained(
        childBounds,
        activeBounds.bounds,
        this.containmentThreshold
      )
    ) {
      return false; // Not sufficiently contained
    }

    // EXCEPTION RULES - Keep these even if contained:
    const childTag = node.originalNode.tagName.toLowerCase();
    const childRole = node.originalNode.attributes?.role;
    const childAttributes = { tag: childTag, role: childRole };

    // 1. Never exclude form elements (they need individual interaction)
    if (['input', 'select', 'textarea', 'label'].includes(childTag)) {
      return false;
    }

    // 2. Keep if child is also a propagating element
    if (this.isPropagatingElement(childAttributes)) {
      return false;
    }

    // 3. Keep if has explicit onclick handler
    if (node.originalNode.attributes?.onclick) {
      return false;
    }

    // 4. Keep if has aria-label suggesting it's independently interactive
    const ariaLabel = node.originalNode.attributes?.['aria-label'];
    if (ariaLabel && ariaLabel.trim()) {
      return false;
    }

    // 5. Keep if has role suggesting interactivity
    if (
      childRole &&
      ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'].includes(
        childRole
      )
    ) {
      return false;
    }

    // Default: exclude this child
    return true;
  }

  /**
   * Check if child is contained within parent bounds
   */
  private isContained(
    child: DOMRect,
    parent: DOMRect,
    threshold: number
  ): boolean {
    // Calculate intersection
    const xOverlap = Math.max(
      0,
      Math.min(child.x + child.width, parent.x + parent.width) -
        Math.max(child.x, parent.x)
    );
    const yOverlap = Math.max(
      0,
      Math.min(child.y + child.height, parent.y + parent.height) -
        Math.max(child.y, parent.y)
    );

    const intersectionArea = xOverlap * yOverlap;
    const childArea = child.width * child.height;

    if (childArea === 0) {
      return false; // Zero-area element
    }

    const containmentRatio = intersectionArea / childArea;
    return containmentRatio >= threshold;
  }

  /**
   * Count how many nodes were excluded (for debugging)
   */
  private countExcludedNodes(node: SimplifiedNode, count = 0): number {
    if (node.excludedByParent) {
      count += 1;
    }
    for (const child of node.children) {
      count = this.countExcludedNodes(child, count);
    }
    return count;
  }

  /**
   * Check if an element should propagate bounds based on attributes
   */
  private isPropagatingElement(attributes: {
    tag: string;
    role?: string | null;
  }): boolean {
    const keysToCheck = ['tag', 'role'] as const;
    return DOMTreeSerializer.PROPAGATING_ELEMENTS.some((pattern) => {
      return keysToCheck.every(
        (key) => pattern[key] === null || pattern[key] === attributes[key]
      );
    });
  }

  /**
   * Assign interactive indices to clickable elements that are also visible
   */
  private assignInteractiveIndicesAndMarkNewNodes(
    node: SimplifiedNode | null
  ): void {
    if (!node) {
      return;
    }

    // Skip assigning index to excluded nodes
    if (!node.excludedByParent) {
      // Assign index to clickable elements that are also visible
      const isInteractiveAssign = this.isInteractiveCached(node.originalNode);
      const isVisible =
        node.originalNode.snapShotNode && node.originalNode.isVisible;

      // Only add to selector map if element is both interactive AND visible
      if (isInteractiveAssign && isVisible) {
        node.interactiveIndex = this.interactiveCounter;
        node.originalNode.elementIndex = this.interactiveCounter;
        this.selectorMap[this.interactiveCounter] = node.originalNode;
        this.interactiveCounter += 1;

        // Check if node is new
        if (this.previousCachedSelectorMap) {
          const previousBackendNodeIds = new Set(
            Object.values(this.previousCachedSelectorMap).map(
              (n) => n.backendNodeId
            )
          );
          if (!previousBackendNodeIds.has(node.originalNode.backendNodeId)) {
            node.isNew = true;
          }
        }
      }
    }

    // Process children
    for (const child of node.children) {
      this.assignInteractiveIndicesAndMarkNewNodes(child);
    }
  }

  /**
   * Serialize the optimized tree to string format
   */
  static serializeTree(
    node: SimplifiedNode | null,
    includeAttributes: string[],
    depth = 0
  ): string {
    if (!node) {
      return '';
    }

    // Skip rendering excluded nodes, but process their children
    if (node.excludedByParent) {
      const formattedText: string[] = [];
      for (const child of node.children) {
        const childText = DOMTreeSerializer.serializeTree(
          child,
          includeAttributes,
          depth
        );
        if (childText) {
          formattedText.push(childText);
        }
      }
      return formattedText.join('\n');
    }

    const formattedText: string[] = [];
    const depthStr = '\t'.repeat(depth);
    let nextDepth = depth;

    if (node.originalNode.nodeType === 1 /* NodeType.ELEMENT_NODE */) {
      // Skip displaying nodes marked as should_display=False
      if (node.shouldDisplay === false) {
        for (const child of node.children) {
          const childText = DOMTreeSerializer.serializeTree(
            child,
            includeAttributes,
            depth
          );
          if (childText) {
            formattedText.push(childText);
          }
        }
        return formattedText.join('\n');
      }

      // Add element with interactive_index if clickable, scrollable, or iframe
      const isAnyScrollable =
        node.originalNode.isActuallyScrollable ||
        node.originalNode.isScrollable;
      const shouldShowScroll = node.originalNode.shouldShowScrollInfo;

      if (
        node.interactiveIndex !== undefined ||
        isAnyScrollable ||
        node.originalNode.tagName.toUpperCase() === 'IFRAME'
      ) {
        nextDepth += 1;

        // Build attributes string
        const attributesHtmlStr = DOMTreeSerializer.buildAttributesString(
          node.originalNode,
          includeAttributes,
          ''
        );

        // Build the line
        let line: string;
        if (shouldShowScroll && node.interactiveIndex === undefined) {
          // Scrollable container but not clickable
          line = `${depthStr}|SCROLL|<${node.originalNode.tagName}`;
        } else if (node.interactiveIndex !== undefined) {
          // Clickable (and possibly scrollable)
          const newPrefix = node.isNew ? '*' : '';
          const scrollPrefix = shouldShowScroll ? '|SCROLL+' : '[';
          line = `${depthStr}${newPrefix}${scrollPrefix}${node.interactiveIndex}]<${node.originalNode.tagName}`;
        } else if (node.originalNode.tagName.toUpperCase() === 'IFRAME') {
          // Iframe element (not interactive)
          line = `${depthStr}|IFRAME|<${node.originalNode.tagName}`;
        } else {
          line = `${depthStr}<${node.originalNode.tagName}`;
        }

        if (attributesHtmlStr) {
          line += ` ${attributesHtmlStr}`;
        }

        line += ' />';

        // Add scroll information only when we should show it
        if (shouldShowScroll) {
          const scrollInfoText = this.getScrollInfoText(node.originalNode);
          if (scrollInfoText) {
            line += ` (${scrollInfoText})`;
          }
        }

        formattedText.push(line);
      }
    } else if (node.originalNode.nodeType === 3 /* NodeType.TEXT_NODE */) {
      // Include visible text
      const isVisible =
        node.originalNode.snapShotNode && node.originalNode.isVisible;
      if (
        isVisible &&
        node.originalNode.nodeValue &&
        node.originalNode.nodeValue.trim() &&
        node.originalNode.nodeValue.trim().length > 1
      ) {
        const cleanText = node.originalNode.nodeValue.trim();
        formattedText.push(`${depthStr}${cleanText}`);
      }
    }

    // Process children
    for (const child of node.children) {
      const childText = DOMTreeSerializer.serializeTree(
        child,
        includeAttributes,
        nextDepth
      );
      if (childText) {
        formattedText.push(childText);
      }
    }

    return formattedText.join('\n');
  }

  /**
   * Get scroll info text for an element
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private static getScrollInfoText(_node: EnhancedDOMTreeNode): string {
    // This would need to be implemented based on the actual scroll info requirements
    return '';
  }

  /**
   * Build the attributes string for an element
   */
  private static buildAttributesString(
    node: EnhancedDOMTreeNode,
    includeAttributes: string[],
    text: string
  ): string {
    const attributesToInclude: Record<string, string> = {};

    // Include HTML attributes
    if (node.attributes) {
      for (const [key, value] of Object.entries(node.attributes)) {
        if (includeAttributes.includes(key) && value && value.trim() !== '') {
          attributesToInclude[key] = value.trim();
        }
      }
    }

    // Include accessibility properties
    if (node.axNode?.properties) {
      for (const prop of node.axNode.properties) {
        try {
          if (includeAttributes.includes(prop.name) && prop.value != null) {
            // Convert boolean to lowercase string, keep others as-is
            if (typeof prop.value === 'boolean') {
              attributesToInclude[prop.name] = prop.value
                .toString()
                .toLowerCase();
            } else {
              const propValueStr = prop.value.toString().trim();
              if (propValueStr) {
                attributesToInclude[prop.name] = propValueStr;
              }
            }
          }
        } catch {
          continue;
        }
      }
    }

    if (Object.keys(attributesToInclude).length === 0) {
      return '';
    }

    // Remove duplicate values
    const orderedKeys = includeAttributes.filter(
      (key) => key in attributesToInclude
    );

    if (orderedKeys.length > 1) {
      const keysToRemove = new Set<string>();
      const seenValues: Record<string, string> = {};

      for (const key of orderedKeys) {
        const value = attributesToInclude[key];
        if (value.length > 5) {
          if (value in seenValues) {
            keysToRemove.add(key);
          } else {
            seenValues[value] = key;
          }
        }
      }

      Array.from(keysToRemove).forEach((key) => {
        delete attributesToInclude[key];
      });
    }

    // Remove attributes that duplicate accessibility data
    const role = node.axNode?.role;
    if (role && node.nodeName === role) {
      delete attributesToInclude.role;
    }

    const attrsToRemoveIfTextMatches = ['aria-label', 'placeholder', 'title'];
    for (const attr of attrsToRemoveIfTextMatches) {
      if (
        attributesToInclude[attr] &&
        attributesToInclude[attr].toLowerCase() === text.toLowerCase()
      ) {
        delete attributesToInclude[attr];
      }
    }

    if (Object.keys(attributesToInclude).length > 0) {
      return Object.entries(attributesToInclude)
        .map(([key, value]) => `${key}=${this.capTextLength(value, 100)}`)
        .join(' ');
    }

    return '';
  }

  // ========== SIMPLIFIED SERIALIZATION METHODS (ViewportDOMService compatibility) ==========

  /**
   * Create a type adapter to convert DOMElementNode to EnhancedDOMTreeNode
   */
  private static createTypeAdapter(node: DOMElementNode): EnhancedDOMTreeNode {
    return {
      nodeId: node.highlightIndex || 0,
      backendNodeId: node.highlightIndex || 0,
      nodeType: 1, // ELEMENT_NODE
      nodeName: node.tagName.toUpperCase(),
      tagName: node.tagName.toUpperCase(),
      attributes: node.attributes,
      children: [],
      childrenAndShadowRoots: [],
      isVisible: node.isVisible,
      isActuallyScrollable: (node as any).isScrollable || false,
      isScrollable: (node as any).isScrollable || false,
      shouldShowScrollInfo: (node as any).shouldShowScrollInfo || false,
      axNode: {
        role: node.attributes?.role,
        properties: Object.entries(node.attributes || {}).map(
          ([name, value]) => ({
            name,
            value,
          })
        ),
      },
      snapShotNode: {
        bounds: {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
      },
    };
  }

  /**
   * Generate simplified clickable elements string
   * This method provides compatibility with ViewportDOMService
   */
  static clickableElementsToStringViewportAware(
    elementTree: DOMElementNode,
    options: SimplifiedDOMOptions = {
      maxTotalLength: 40000,
    },
    includeAttributes: string[] = DEFAULT_INCLUDE_ATTRIBUTES,
    previousSelectorMap?: Record<number, DOMElementNode>
  ): string {
    const logger = getLogger();
    logger.debug('Simplified DOM processing', {
      maxTotalLength: options.maxTotalLength,
    });

    // Generate tree-structured string similar
    const result = this.serializeTreeToString(
      elementTree,
      includeAttributes,
      0,
      previousSelectorMap
    );

    // Apply length limiting if needed
    let finalResult = result;
    if (result.length > options.maxTotalLength) {
      finalResult = result.substring(0, options.maxTotalLength);
      const lastNewlineIndex = finalResult.lastIndexOf('\n');
      if (lastNewlineIndex > 0) {
        finalResult = finalResult.substring(0, lastNewlineIndex);
      }
      finalResult += '\n... (truncated to fit length limit)';
    }

    logger.debug('Generated simplified DOM string', {
      totalLength: finalResult.length,
      truncated: finalResult.length < result.length,
    });

    return finalResult;
  }

  /**
   * Get all text content from an element until the next clickable element
   * This matches the Python version's get_all_text_till_next_clickable_element method
   */
  static getAllTextTillNextClickableElement(
    element: DOMElementNode,
    maxDepth: number = -1
  ): string {
    const textParts: string[] = [];

    function collectText(node: DOMBaseNode, currentDepth: number): void {
      if (maxDepth !== -1 && currentDepth > maxDepth) {
        return;
      }

      // Skip this branch if we hit a highlighted element (except for the current node)
      if (
        node.type !== 'TEXT_NODE' &&
        node !== element &&
        (node as DOMElementNode).highlightIndex !== null
      ) {
        return;
      }

      if (node.type === 'TEXT_NODE') {
        const textNode = node as DOMTextNode;
        if (textNode.text && textNode.text.trim()) {
          textParts.push(textNode.text);
        }
      } else if (node.type !== 'TEXT_NODE') {
        const elementNode = node as DOMElementNode;
        for (const child of elementNode.children) {
          collectText(child, currentDepth + 1);
        }
      }
    }

    collectText(element, 0);
    return textParts.join('\n').trim();
  }

  /**
   * Check if a text node has a parent with highlight_index
   * This matches the Python version's has_parent_with_highlight_index method
   */
  private static hasParentWithHighlightIndex(textNode: DOMTextNode): boolean {
    let current = textNode.parent;
    while (current) {
      if (current.type !== 'TEXT_NODE') {
        const elementNode = current as DOMElementNode;
        if (elementNode.highlightIndex !== null) {
          return true;
        }
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Serialize DOM tree to string format for simplified mode
   * Completely rewritten to match Python version's clickable_elements_to_string logic
   */
  private static serializeTreeToString(
    node: DOMBaseNode | null,
    includeAttributes: string[],
    depth: number = 0,
    previousSelectorMap?: Record<number, DOMElementNode>
  ): string {
    if (!node) {
      return '';
    }

    const formattedText: string[] = [];
    const depthStr = '\t'.repeat(depth);
    let nextDepth = depth;

    if (node.type !== 'TEXT_NODE') {
      const elementNode = node as DOMElementNode;

      // Process elements with highlight_index (interactive elements) - matches Python logic
      if (elementNode.highlightIndex !== null) {
        nextDepth += 1;

        // Get element's complete text content (KEY: this matches Python's get_all_text_till_next_clickable_element)
        const text = this.getAllTextTillNextClickableElement(elementNode);

        // Build attributes string (pass text for deduplication logic)
        const attributesStr = this.buildAttributesStringSimplified(
          elementNode,
          includeAttributes,
          text
        );

        // Check if this element is new (matches Python version exactly)
        let isNew = elementNode.isNew || false;

        // If we have a previous selector map, check if this element is new
        if (previousSelectorMap && !isNew) {
          // Use xpath as unique identifier for comparison since it's stable across DOM changes
          const currentXpath = elementNode.xpath;
          const elementExistedBefore = Object.values(previousSelectorMap).some(
            (prevElement) => prevElement.xpath === currentXpath
          );
          isNew = !elementExistedBefore;
        }

        // Build the line (matches Python format exactly)
        let line = `${depthStr}${isNew ? '*' : ''}[${elementNode.highlightIndex}]<${elementNode.tagName}`;

        if (attributesStr) {
          line += ` ${attributesStr}`;
        }

        if (text && text.trim()) {
          const cleanText = text.trim();
          // Add space before >text only if there were NO attributes added before
          if (!attributesStr) {
            line += ' ';
          }
          line += `>${cleanText}`;
        } else if (!attributesStr) {
          // Add space before /> only if neither attributes NOR text were added
          line += ' ';
        }

        line += ' />';
        formattedText.push(line);
      }

      // Process children regardless (matches Python logic)
      for (const child of elementNode.children) {
        const childText = this.serializeTreeToString(
          child,
          includeAttributes,
          nextDepth,
          previousSelectorMap
        );
        if (childText) {
          formattedText.push(childText);
        }
      }
    } else {
      // Handle text nodes - matches Python logic exactly
      const textNode = node as DOMTextNode;

      // Add text only if it doesn't have a highlighted parent
      if (!this.hasParentWithHighlightIndex(textNode)) {
        const parent = textNode.parent as DOMElementNode;
        if (
          parent &&
          // TODO: this is a hack to include text from hidden elements
          // parent.isVisible &&
          (parent.isTopElement ||
            parent.isInViewport ||
            textNode.text?.trim().length > 0)
        ) {
          formattedText.push(`${depthStr}${textNode.text}`);
        }
      }
    }

    return formattedText.join('\n');
  }

  /**
   * Build attributes string for an element - matches Python version exactly
   * This includes the complex attribute deduplication and optimization logic
   */
  private static buildAttributesStringSimplified(
    element: DOMElementNode,
    includeAttributes: string[],
    text: string = ''
  ): string {
    // First, get all attributes that exist and have non-empty values
    const attributesToInclude: Record<string, string> = {};
    for (const key of includeAttributes) {
      const value = element.attributes[key];
      if (value && value.trim() !== '') {
        attributesToInclude[key] = value.trim();
      }
    }

    // If value of any of the attributes is the same as ANY other value attribute
    // only include the one that appears first in include_attributes
    // WARNING: heavy vibes, but it seems good enough for saving tokens (it kicks in hard when it's long text)

    // Pre-compute ordered keys that exist in both lists (faster than repeated lookups)
    const orderedKeys = includeAttributes.filter(
      (key) => key in attributesToInclude
    );

    if (orderedKeys.length > 1) {
      // Only process if we have multiple attributes
      const keysToRemove = new Set<string>(); // Use set for O(1) lookups
      const seenValues: Record<string, string> = {}; // value -> first_key_with_this_value

      for (const key of orderedKeys) {
        const value = attributesToInclude[key];
        if (value.length > 5) {
          // to not remove false, true, etc
          if (value in seenValues) {
            // This value was already seen with an earlier key, so remove this key
            keysToRemove.add(key);
          } else {
            // First time seeing this value, record it
            seenValues[value] = key;
          }
        }
      }

      // Remove duplicate keys
      Array.from(keysToRemove).forEach((key) => {
        delete attributesToInclude[key];
      });
    }

    // Easy LLM optimizations
    // if tag == role attribute, don't include it
    if (
      element.tagName.toLowerCase() ===
      attributesToInclude['role']?.toLowerCase()
    ) {
      delete attributesToInclude['role'];
    }

    // Remove attributes that duplicate the node's text content
    const attrsToRemoveIfTextMatches = ['aria-label', 'placeholder', 'title'];
    for (const attr of attrsToRemoveIfTextMatches) {
      if (
        attributesToInclude[attr] &&
        attributesToInclude[attr].toLowerCase() === text.trim().toLowerCase()
      ) {
        delete attributesToInclude[attr];
      }
    }

    if (Object.keys(attributesToInclude).length === 0) {
      return '';
    }

    // Format as key1='value1' key2='value2' (with proper length capping)
    return Object.entries(attributesToInclude)
      .map(([key, value]) => `${key}=${this.capTextLength(value, 15)}`)
      .join(' ');
  }

  /**
   * Cap text length - matches Python version's cap_text_length function
   */
  private static capTextLength(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return `'${text}'`;
    }
    return `'${text.substring(0, maxLength)}...'`;
  }
}

/**
 * Compatibility class to provide the same interface as ViewportDOMService
 * This delegates to the static methods in DOMTreeSerializer
 */
export class ViewportDOMService {
  private domLogger = getLogger();
  private previousSelectorMap?: Record<number, DOMElementNode>;

  /**
   * Generate simplified clickable elements string consistent
   */
  clickableElementsToStringViewportAware(
    elementTree: DOMElementNode,
    options: SimplifiedDOMOptions = {
      maxTotalLength: 40000,
    },
    includeAttributes: string[] = DEFAULT_INCLUDE_ATTRIBUTES
  ): string {
    const result = DOMTreeSerializer.clickableElementsToStringViewportAware(
      elementTree,
      options,
      includeAttributes,
      this.previousSelectorMap
    );

    // Update the previous selector map for next comparison
    this.updatePreviousSelectorMap(elementTree);

    return result;
  }

  /**
   * Update the previous selector map with current interactive elements
   */
  private updatePreviousSelectorMap(elementTree: DOMElementNode): void {
    this.previousSelectorMap = {};
    this.collectInteractiveElements(elementTree);
  }

  /**
   * Recursively collect interactive elements for comparison
   * Use xpath as key instead of highlightIndex for stable comparison
   */
  private collectInteractiveElements(node: DOMElementNode): void {
    if (
      node.highlightIndex !== null &&
      this.previousSelectorMap &&
      node.xpath
    ) {
      // Use a stable key based on xpath instead of dynamic highlightIndex
      this.previousSelectorMap[node.highlightIndex] = node;
    }

    for (const child of node.children) {
      if (child.type !== 'TEXT_NODE') {
        this.collectInteractiveElements(child as DOMElementNode);
      }
    }
  }
}

/**
 * Create simplified DOM service instance (compatibility function)
 */
export function createViewportAwareDOMService(): ViewportDOMService {
  return new ViewportDOMService();
}

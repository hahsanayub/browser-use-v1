/**
 * DOM Tree Adapter - Converts buildDomTree.js results to EnhancedDOMTreeNode format
 * for use with the new DOMTreeSerializer
 */

import type {
  DOMResult,
  DOMNode,
  EnhancedDOMTreeNode,
  NodeType,
  DOMRect,
  SnapshotNode,
  AccessibilityNode,
} from '../types/dom';

export class DOMTreeAdapter {
  /**
   * Convert buildDomTree.js result to EnhancedDOMTreeNode format
   */
  static convertToEnhancedDOMTree(
    domResult: DOMResult
  ): EnhancedDOMTreeNode | null {
    if (!domResult.rootId || !domResult.map) {
      return null;
    }

    const nodeMap = new Map<string, EnhancedDOMTreeNode>();

    // First pass: create all nodes
    for (const [id, domNode] of Object.entries(domResult.map)) {
      const enhancedNode = this.convertDOMNodeToEnhanced(domNode, id);
      if (enhancedNode) {
        nodeMap.set(id, enhancedNode);
      }
    }

    // Second pass: establish parent-child relationships
    for (const [id, domNode] of Object.entries(domResult.map)) {
      const enhancedNode = nodeMap.get(id);
      if (!enhancedNode || !domNode.children) continue;

      const children: EnhancedDOMTreeNode[] = [];
      for (const childId of domNode.children) {
        const childNode = nodeMap.get(childId);
        if (childNode) {
          children.push(childNode);
        }
      }

      enhancedNode.children = children;
      enhancedNode.childrenAndShadowRoots = children; // For now, same as children
    }

    return nodeMap.get(domResult.rootId) || null;
  }

  /**
   * Convert a single DOMNode to EnhancedDOMTreeNode
   */
  private static convertDOMNodeToEnhanced(
    domNode: DOMNode,
    id: string
  ): EnhancedDOMTreeNode | null {
    // Handle text nodes
    if (domNode.type === 'TEXT_NODE') {
      return {
        nodeId: parseInt(id, 10) || 0,
        backendNodeId: parseInt(id, 10) || 0,
        nodeType: 3 as NodeType, // TEXT_NODE
        nodeName: '#text',
        tagName: '',
        nodeValue: domNode.text || '',
        children: [],
        childrenAndShadowRoots: [],
        isVisible: domNode.isVisible || false,
        isActuallyScrollable: false,
        isScrollable: false,
        shouldShowScrollInfo: false,
        snapShotNode: this.createSnapshotNode(domNode),
      };
    }

    // Handle element nodes
    const nodeType = this.getNodeType(domNode.tagName);

    return {
      nodeId: parseInt(id, 10) || 0,
      backendNodeId: parseInt(id, 10) || 0,
      nodeType,
      nodeName: domNode.tagName?.toUpperCase() || '',
      tagName: domNode.tagName || '',
      nodeValue: undefined,
      attributes: domNode.attributes || {},
      children: [], // Will be populated in second pass
      childrenAndShadowRoots: [], // Will be populated in second pass
      isVisible: domNode.isVisible || false,
      isActuallyScrollable: false,
      isScrollable: false,
      shouldShowScrollInfo: false,
      elementIndex: domNode.highlightIndex,
      snapShotNode: this.createSnapshotNode(domNode),
      axNode: this.createAccessibilityNode(domNode),
    };
  }

  /**
   * Determine NodeType from tag name
   */
  private static getNodeType(tagName?: string): NodeType {
    if (!tagName) return 3 as NodeType; // TEXT_NODE
    if (tagName.toLowerCase() === 'html') return 9 as NodeType; // DOCUMENT_NODE
    return 1 as NodeType; // ELEMENT_NODE
  }

  /**
   * Create SnapshotNode from DOMNode data
   */
  private static createSnapshotNode(
    domNode: DOMNode
  ): SnapshotNode | undefined {
    // The buildDomTree.js doesn't provide bounding box information directly
    // This would need to be enhanced to include actual bounding box data
    // For now, return undefined as we don't have this information
    return undefined;
  }

  /**
   * Create AccessibilityNode from DOMNode data
   */
  private static createAccessibilityNode(
    domNode: DOMNode
  ): AccessibilityNode | undefined {
    // Extract role from attributes if available
    const role = domNode.attributes?.role;

    if (!role) return undefined;

    return {
      role,
      properties: [], // buildDomTree.js doesn't provide detailed accessibility properties
    };
  }

  /**
   * Create a mock EnhancedDOMTreeNode for testing purposes
   */
  static createMockEnhancedNode(
    tagName: string,
    attributes: Record<string, string> = {},
    bounds?: DOMRect
  ): EnhancedDOMTreeNode {
    return {
      nodeId: Math.random() * 1000000,
      backendNodeId: Math.random() * 1000000,
      nodeType: 1 as NodeType, // ELEMENT_NODE
      nodeName: tagName.toUpperCase(),
      tagName: tagName.toLowerCase(),
      attributes,
      children: [],
      childrenAndShadowRoots: [],
      isVisible: true,
      isActuallyScrollable: false,
      isScrollable: false,
      shouldShowScrollInfo: false,
      snapShotNode: bounds ? { bounds } : undefined,
    };
  }
}

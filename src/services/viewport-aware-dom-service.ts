/**
 * Viewport-aware DOM service for better screenshot-prompt consistency
 */

import { DOMService } from './dom-service';
import { DOMElementNode, DOMBaseNode, DOMTextNode } from '../types/dom';
import { getLogger } from './logging';

export interface ViewportAwareOptions {
  /** Maximum total length of the elements string */
  maxTotalLength: number;
  /** Ratio of content to prioritize from viewport vs outside viewport (0.8 = 80% viewport, 20% outside) */
  viewportPriorityRatio: number;
  /** Whether to include elements outside viewport at all */
  includeOutsideViewport: boolean;
}

/**
 * Enhanced DOM service that prioritizes viewport content for better consistency with screenshots
 */
export class ViewportAwareDOMService extends DOMService {
  private viewportLogger = getLogger();

  /**
   * Generate viewport-aware clickable elements string that prioritizes visible content
   */
  clickableElementsToStringViewportAware(
    elementTree: DOMElementNode,
    options: ViewportAwareOptions = {
      maxTotalLength: 40000,
      viewportPriorityRatio: 0.8,
      includeOutsideViewport: true,
    },
    includeAttributes: string[] = [
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
    ]
  ): string {
    // Collect elements separated by viewport status
    const viewportElements: DOMElementNode[] = [];
    const outsideViewportElements: DOMElementNode[] = [];

    this.collectElementsByViewport(
      elementTree,
      viewportElements,
      outsideViewportElements
    );

    this.viewportLogger.debug('Viewport-aware DOM processing', {
      viewportElements: viewportElements.length,
      outsideViewportElements: outsideViewportElements.length,
      maxTotalLength: options.maxTotalLength,
      viewportPriorityRatio: options.viewportPriorityRatio,
    });

    // Calculate length budgets
    const viewportBudget = Math.floor(
      options.maxTotalLength * options.viewportPriorityRatio
    );
    const outsideBudget = options.includeOutsideViewport
      ? options.maxTotalLength - viewportBudget
      : 0;

    // Generate strings with length limits
    const viewportString = this.generateElementString(
      viewportElements,
      viewportBudget,
      includeAttributes,
      'viewport'
    );

    let outsideString = '';
    if (options.includeOutsideViewport && outsideBudget > 0) {
      outsideString = this.generateElementString(
        outsideViewportElements,
        outsideBudget,
        includeAttributes,
        'outside-viewport'
      );
    }

    // Combine results
    const parts: string[] = [];

    if (viewportString) {
      parts.push('--- VISIBLE IN CURRENT VIEWPORT ---');
      parts.push(viewportString);
    }

    if (outsideString) {
      parts.push('--- OUTSIDE CURRENT VIEWPORT ---');
      parts.push(outsideString);
    }

    const result = parts.join('\n');

    this.viewportLogger.debug('Generated viewport-aware DOM string', {
      totalLength: result.length,
      viewportStringLength: viewportString.length,
      outsideStringLength: outsideString.length,
      truncated: result.length >= options.maxTotalLength,
    });

    return result;
  }

  /**
   * Collect elements by viewport status
   */
  private collectElementsByViewport(
    node: DOMBaseNode,
    viewportElements: DOMElementNode[],
    outsideViewportElements: DOMElementNode[]
  ): void {
    if (node.type !== 'TEXT_NODE') {
      const elementNode = node as DOMElementNode;

      // Add highlighted interactive elements
      if (elementNode.highlightIndex !== null) {
        if (elementNode.isInViewport) {
          viewportElements.push(elementNode);
        } else {
          outsideViewportElements.push(elementNode);
        }
      }

      // Recursively process children
      for (const child of elementNode.children) {
        this.collectElementsByViewport(
          child,
          viewportElements,
          outsideViewportElements
        );
      }
    }
  }

  /**
   * Generate string representation for a list of elements with length budget
   */
  private generateElementString(
    elements: DOMElementNode[],
    maxLength: number,
    includeAttributes: string[],
    section: string
  ): string {
    if (elements.length === 0 || maxLength <= 0) {
      return '';
    }

    const lines: string[] = [];
    let currentLength = 0;
    let truncatedCount = 0;

    for (const element of elements) {
      const line = this.formatElement(element, includeAttributes);

      if (currentLength + line.length + 1 > maxLength) {
        truncatedCount = elements.length - lines.length;
        break;
      }

      lines.push(line);
      currentLength += line.length + 1; // +1 for newline
    }

    let result = lines.join('\n');

    if (truncatedCount > 0) {
      result += `\n... and ${truncatedCount} more ${section} elements (truncated to fit within length limit)`;
    }

    return result;
  }

  /**
   * Format a single element to string
   */
  private formatElement(
    element: DOMElementNode,
    includeAttributes: string[]
  ): string {
    // Get text content
    const text = this.getElementText(element);

    // Build attributes string
    let attributesStr = '';
    if (includeAttributes.length > 0) {
      const attrs: string[] = [];
      for (const attr of includeAttributes) {
        const value = element.attributes[attr];
        if (value && value.trim() !== '') {
          attrs.push(`${attr}=${this.truncateText(value.trim(), 15)}`);
        }
      }
      if (attrs.length > 0) {
        attributesStr = ` ${attrs.join(' ')}`;
      }
    }

    // Format the line
    let line = `[${element.highlightIndex}]<${element.tagName}`;
    if (attributesStr) {
      line += attributesStr;
    }
    if (text) {
      if (!attributesStr) line += ' ';
      line += `>${text}`;
    }
    if (!attributesStr && !text) {
      line += ' ';
    }
    line += ' />';

    return line;
  }

  /**
   * Get text content from element
   */
  private getElementText(element: DOMElementNode): string {
    const textParts: string[] = [];

    const collectText = (node: DOMBaseNode): void => {
      if (node.type === 'TEXT_NODE') {
        const textNode = node as DOMTextNode;
        textParts.push(textNode.text);
      } else {
        const elementNode = node as DOMElementNode;
        // Only collect text from non-highlighted children
        for (const child of elementNode.children) {
          if (
            child.type === 'TEXT_NODE' ||
            (child.type !== 'TEXT_NODE' &&
              (child as DOMElementNode).highlightIndex === null)
          ) {
            collectText(child);
          }
        }
      }
    };

    collectText(element);
    return this.truncateText(textParts.join(' ').trim(), 50);
  }

  /**
   * Truncate text with ellipsis
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length > maxLength) {
      return text.substring(0, maxLength) + '...';
    }
    return text;
  }
}

/**
 * Create viewport-aware DOM service instance
 */
export function createViewportAwareDOMService(): ViewportAwareDOMService {
  return new ViewportAwareDOMService();
}

/**
 * Clickable Element Detector - Enhanced detection of interactive elements
 * Based on Python version with comprehensive interactive element detection
 */

import type { EnhancedDOMTreeNode, NodeType } from '../types/dom';

export class ClickableElementDetector {
  /**
   * Check if this node is clickable/interactive using enhanced scoring
   */
  static isInteractive(node: EnhancedDOMTreeNode): boolean {
    // Skip non-element nodes
    if (node.nodeType !== 1 /* NodeType.ELEMENT_NODE */) {
      return false;
    }

    // Remove html and body nodes
    if (['html', 'body'].includes(node.tagName.toLowerCase())) {
      return false;
    }

    // IFRAME elements should be interactive if they're large enough to potentially need scrolling
    // Small iframes (< 100px width or height) are unlikely to have scrollable content
    if (node.tagName && node.tagName.toUpperCase() === 'IFRAME') {
      if (node.snapShotNode?.bounds) {
        const { width, height } = node.snapShotNode.bounds;
        // Only include iframes larger than 100x100px
        if (width > 100 && height > 100) {
          return true;
        }
      }
    }

    // SEARCH ELEMENT DETECTION: Check for search-related classes and attributes
    if (node.attributes) {
      const searchIndicators = new Set([
        'search',
        'magnify',
        'glass',
        'lookup',
        'find',
        'query',
        'search-icon',
        'search-btn',
        'search-button',
        'searchbox',
      ]);

      // Check class names for search indicators
      const classList = (node.attributes.class || '')
        .toLowerCase()
        .split(/\s+/);
      if (
        classList.some(
          (cls) =>
            searchIndicators.has(cls) ||
            Array.from(searchIndicators).some((indicator) =>
              cls.includes(indicator)
            )
        )
      ) {
        return true;
      }

      // Check id for search indicators
      const elementId = (node.attributes.id || '').toLowerCase();
      if (
        Array.from(searchIndicators).some((indicator) =>
          elementId.includes(indicator)
        )
      ) {
        return true;
      }

      // Check data attributes for search functionality
      for (const [attrName, attrValue] of Object.entries(node.attributes)) {
        if (
          attrName.startsWith('data-') &&
          Array.from(searchIndicators).some((indicator) =>
            (attrValue || '').toLowerCase().includes(indicator)
          )
        ) {
          return true;
        }
      }
    }

    // Enhanced accessibility property checks - direct clear indicators only
    if (node.axNode?.properties) {
      for (const prop of node.axNode.properties) {
        try {
          // aria disabled
          if (prop.name === 'disabled' && prop.value) {
            return false;
          }

          // aria hidden
          if (prop.name === 'hidden' && prop.value) {
            return false;
          }

          // Direct interactiveness indicators
          if (
            ['focusable', 'editable', 'settable'].includes(prop.name) &&
            prop.value
          ) {
            return true;
          }

          // Interactive state properties (presence indicates interactive widget)
          if (
            ['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)
          ) {
            // These properties only exist on interactive elements
            return true;
          }

          // Form-related interactiveness
          if (['required', 'autocomplete'].includes(prop.name) && prop.value) {
            return true;
          }

          // Elements with keyboard shortcuts are interactive
          if (prop.name === 'keyshortcuts' && prop.value) {
            return true;
          }
        } catch {
          // Skip properties we can't process
          continue;
        }
      }
    }

    // ENHANCED TAG CHECK: Include truly interactive elements
    const interactiveTags = new Set([
      'button',
      'input',
      'select',
      'textarea',
      'a',
      'label',
      'details',
      'summary',
      'option',
      'optgroup',
    ]);

    if (interactiveTags.has(node.tagName.toLowerCase())) {
      return true;
    }

    // Tertiary check: elements with interactive attributes
    if (node.attributes) {
      // Check for event handlers or interactive attributes
      const interactiveAttributes = new Set([
        'onclick',
        'onmousedown',
        'onmouseup',
        'onkeydown',
        'onkeyup',
        'tabindex',
      ]);

      if (
        Object.keys(node.attributes).some((attr) =>
          interactiveAttributes.has(attr)
        )
      ) {
        return true;
      }

      // Check for interactive ARIA roles
      if (node.attributes.role) {
        const interactiveRoles = new Set([
          'button',
          'link',
          'menuitem',
          'option',
          'radio',
          'checkbox',
          'tab',
          'textbox',
          'combobox',
          'slider',
          'spinbutton',
          'search',
          'searchbox',
        ]);

        if (interactiveRoles.has(node.attributes.role)) {
          return true;
        }
      }
    }

    // Quaternary check: accessibility tree roles
    if (node.axNode?.role) {
      const interactiveAxRoles = new Set([
        'button',
        'link',
        'menuitem',
        'option',
        'radio',
        'checkbox',
        'tab',
        'textbox',
        'combobox',
        'slider',
        'spinbutton',
        'listbox',
        'search',
        'searchbox',
      ]);

      if (interactiveAxRoles.has(node.axNode.role)) {
        return true;
      }
    }

    // ICON AND SMALL ELEMENT CHECK: Elements that might be icons
    if (node.snapShotNode?.bounds) {
      const { width, height } = node.snapShotNode.bounds;

      if (width >= 10 && width <= 50 && height >= 10 && height <= 50) {
        // Check if this small element has interactive properties
        if (node.attributes) {
          // Small elements with these attributes are likely interactive icons
          const iconAttributes = new Set([
            'class',
            'role',
            'onclick',
            'data-action',
            'aria-label',
          ]);
          if (
            Object.keys(node.attributes).some((attr) =>
              iconAttributes.has(attr)
            )
          ) {
            return true;
          }
        }
      }
    }

    // Final fallback: cursor style indicates interactivity (for cases Chrome missed)
    // Note: This would need to be implemented based on actual cursor style detection
    // if (node.snapShotNode?.cursorStyle === 'pointer') {
    //   return true;
    // }

    return false;
  }
}

import { describe, expect, it } from 'vitest';
import { DOMElementNode, DOMTextNode } from '../src/dom/views.js';
import { getClickDescription } from '../src/tools/utils.js';

describe('tools utils alignment', () => {
  it('describes checkbox input state and key attributes', () => {
    const node = new DOMElementNode(
      true,
      null,
      'input',
      '/html/body/input[1]',
      {
        type: 'checkbox',
        checked: 'checked',
        id: 'accept_terms',
        name: 'terms',
      },
      []
    );

    const description = getClickDescription(node);
    expect(description).toContain('input');
    expect(description).toContain('type=checkbox');
    expect(description).toContain('checkbox-state=checked');
    expect(description).toContain('id=accept_terms');
    expect(description).toContain('name=terms');
  });

  it('describes role=checkbox state using aria-checked', () => {
    const node = new DOMElementNode(
      true,
      null,
      'div',
      '/html/body/div[2]',
      {
        role: 'checkbox',
        'aria-checked': 'false',
        'aria-label': 'Subscribe',
      },
      []
    );

    const description = getClickDescription(node);
    expect(description).toContain('role=checkbox');
    expect(description).toContain('checkbox-state=unchecked');
    expect(description).toContain('aria-label=Subscribe');
  });

  it('infers checkbox state from hidden checkbox child and includes text snippet', () => {
    const label = new DOMElementNode(
      true,
      null,
      'label',
      '/html/body/label[1]',
      {},
      []
    );
    const hiddenCheckbox = new DOMElementNode(
      false,
      label,
      'input',
      '/html/body/label[1]/input[1]',
      {
        type: 'checkbox',
        checked: 'true',
      },
      []
    );
    const textNode = new DOMTextNode(
      true,
      label,
      'Subscribe to release notifications'
    );
    label.children = [hiddenCheckbox, textNode];

    const description = getClickDescription(label);
    expect(description).toContain('label');
    expect(description).toContain('checkbox-state=checked');
    expect(description).toContain('"Subscribe to release notificat..."');
  });
});

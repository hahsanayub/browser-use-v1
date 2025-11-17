import crypto from 'node:crypto';
import { DOMElementNode } from '../views.js';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export class ClickableElementProcessor {
	static get_clickable_elements_hashes(dom_element: DOMElementNode) {
		const hashes = new Set<string>();
		for (const element of this.get_clickable_elements(dom_element)) {
			hashes.add(this.hash_dom_element(element));
		}
		return hashes;
	}

	static get_clickable_elements(dom_element: DOMElementNode) {
		const elements: DOMElementNode[] = [];

		const traverse = (node: DOMElementNode) => {
			for (const child of node.children) {
				if (child instanceof DOMElementNode) {
					if (child.highlight_index !== null && child.highlight_index !== undefined) {
						elements.push(child);
					}
					traverse(child);
				}
			}
		};

		traverse(dom_element);
		return elements;
	}

	static hash_dom_element(dom_element: DOMElementNode) {
		const parent_branch_path = this._get_parent_branch_path(dom_element);
		const branch_path_hash = this._parent_branch_path_hash(parent_branch_path);
		const attributes_hash = this._attributes_hash(dom_element.attributes);
		const xpath_hash = this._xpath_hash(dom_element.xpath);
		return this._hash_string(`${branch_path_hash}-${attributes_hash}-${xpath_hash}`);
	}

	private static _get_parent_branch_path(dom_element: DOMElementNode) {
		const parents: DOMElementNode[] = [];
		let current: DOMElementNode | null = dom_element;
		while (current && current.parent) {
			parents.push(current);
			current = current.parent;
		}
		parents.reverse();
		return parents.map((parent) => parent.tag_name);
	}

	private static _parent_branch_path_hash(parent_branch_path: string[]) {
		return sha256(parent_branch_path.join('/'));
	}

	private static _attributes_hash(attributes: Record<string, string>) {
		const attributes_string = Object.entries(attributes)
			.map(([key, value]) => `${key}=${value}`)
			.join('');
		return this._hash_string(attributes_string);
	}

	private static _xpath_hash(xpath: string) {
		return this._hash_string(xpath);
	}

	private static _hash_string(value: string) {
		return sha256(value);
	}
}

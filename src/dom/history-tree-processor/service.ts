import crypto from 'node:crypto';
import { DOMHistoryElement, HashedDomElement } from './view.js';
import { DOMElementNode } from '../views.js';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export class HistoryTreeProcessor {
	static convert_dom_element_to_history_element(dom_element: DOMElementNode, css_selector: string | null = null) {
		const parent_branch_path = this._get_parent_branch_path(dom_element);
		return new DOMHistoryElement(
			dom_element.tag_name,
			dom_element.xpath,
			dom_element.highlight_index ?? null,
			parent_branch_path,
			dom_element.attributes,
			dom_element.shadow_root,
			css_selector,
			dom_element.page_coordinates,
			dom_element.viewport_coordinates,
			dom_element.viewport_info,
		);
	}

	static find_history_element_in_tree(dom_history_element: DOMHistoryElement, tree: DOMElementNode) {
		const hashed = this._hash_dom_history_element(dom_history_element);

		const process_node = (node: DOMElementNode): DOMElementNode | null => {
			if (node.highlight_index !== null && node.highlight_index !== undefined) {
				const hashed_node = this._hash_dom_element(node);
				if (
					hashed_node.branch_path_hash === hashed.branch_path_hash &&
					hashed_node.attributes_hash === hashed.attributes_hash &&
					hashed_node.xpath_hash === hashed.xpath_hash
				) {
					return node;
				}
			}

			for (const child of node.children) {
				if (child instanceof DOMElementNode) {
					const result = process_node(child);
					if (result) {
						return result;
					}
				}
			}

			return null;
		};

		return process_node(tree);
	}

	static compare_history_element_and_dom_element(dom_history_element: DOMHistoryElement, dom_element: DOMElementNode) {
		const hashed_history = this._hash_dom_history_element(dom_history_element);
		const hashed_dom = this._hash_dom_element(dom_element);
		return (
			hashed_history.branch_path_hash === hashed_dom.branch_path_hash &&
			hashed_history.attributes_hash === hashed_dom.attributes_hash &&
			hashed_history.xpath_hash === hashed_dom.xpath_hash
		);
	}

	static _hash_dom_history_element(dom_history_element: DOMHistoryElement) {
		const branch_path_hash = this._parent_branch_path_hash(dom_history_element.entire_parent_branch_path);
		const attributes_hash = this._attributes_hash(dom_history_element.attributes);
		const xpath_hash = this._xpath_hash(dom_history_element.xpath);
		return new HashedDomElement(branch_path_hash, attributes_hash, xpath_hash);
	}

	static _hash_dom_element(dom_element: DOMElementNode) {
		const parent_branch_path = this._get_parent_branch_path(dom_element);
		const branch_path_hash = this._parent_branch_path_hash(parent_branch_path);
		const attributes_hash = this._attributes_hash(dom_element.attributes);
		const xpath_hash = this._xpath_hash(dom_element.xpath);
		return new HashedDomElement(branch_path_hash, attributes_hash, xpath_hash);
	}

	static _get_parent_branch_path(dom_element: DOMElementNode) {
		const parents: DOMElementNode[] = [];
		let current: DOMElementNode | null = dom_element;
		while (current && current.parent) {
			parents.push(current);
			current = current.parent;
		}
		parents.reverse();
		return parents.map((parent) => parent.tag_name);
	}

	static _parent_branch_path_hash(parent_branch_path: string[]) {
		return sha256(parent_branch_path.join('/'));
	}

	static _attributes_hash(attributes: Record<string, string>) {
		const attributes_string = Object.entries(attributes)
			.map(([key, value]) => `${key}=${value}`)
			.join('');
		return sha256(attributes_string);
	}

	static _xpath_hash(xpath: string) {
		return sha256(xpath);
	}

	static _text_hash(dom_element: DOMElementNode) {
		const text = dom_element.get_all_text_till_next_clickable_element();
		return sha256(text);
	}
}

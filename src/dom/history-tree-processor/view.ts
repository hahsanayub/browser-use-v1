export class HashedDomElement {
  constructor(
    public branch_path_hash: string,
    public attributes_hash: string,
    public xpath_hash: string
  ) {}
}

export interface Coordinates {
  x: number;
  y: number;
}

export interface CoordinateSet {
  top_left: Coordinates;
  top_right: Coordinates;
  bottom_left: Coordinates;
  bottom_right: Coordinates;
  center: Coordinates;
  width: number;
  height: number;
}

export interface ViewportInfo {
  scroll_x?: number | null;
  scroll_y?: number | null;
  width: number;
  height: number;
}

export class DOMHistoryElement {
  constructor(
    public tag_name: string,
    public xpath: string,
    public highlight_index: number | null,
    public entire_parent_branch_path: string[],
    public attributes: Record<string, string>,
    public shadow_root = false,
    public css_selector: string | null = null,
    public page_coordinates: CoordinateSet | null = null,
    public viewport_coordinates: CoordinateSet | null = null,
    public viewport_info: ViewportInfo | null = null
  ) {}

  to_dict() {
    return {
      tag_name: this.tag_name,
      xpath: this.xpath,
      highlight_index: this.highlight_index,
      entire_parent_branch_path: this.entire_parent_branch_path,
      attributes: this.attributes,
      shadow_root: this.shadow_root,
      css_selector: this.css_selector,
      page_coordinates: this.page_coordinates,
      viewport_coordinates: this.viewport_coordinates,
      viewport_info: this.viewport_info,
    };
  }
}

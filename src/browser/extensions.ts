/**
 * Browser extension helpers placeholder.
 * The Python implementation contains download/install utilities that rely on Playwright-specific internals.
 * We'll port the logic incrementally; for now expose the intended API surface for future work.
 */

export interface BrowserExtensionDescriptor {
	name: string;
	webstore_id?: string;
	id?: string;
	webstore_url?: string;
	crx_url?: string;
	crx_path?: string;
	unpacked_path?: string;
}

export async function load_or_install_extension(_extension: BrowserExtensionDescriptor) {
	throw new Error('load_or_install_extension is not implemented yet.');
}

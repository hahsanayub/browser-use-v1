export interface ActionResultInit {
	is_done?: boolean | null;
	success?: boolean | null;
	error?: string | null;
	attachments?: string[] | null;
	long_term_memory?: string | null;
	extracted_content?: string | null;
	include_extracted_content_only_once?: boolean;
	include_in_memory?: boolean;
}

export class ActionResult {
	is_done: boolean | null;
	success: boolean | null;
	error: string | null;
	attachments: string[] | null;
	long_term_memory: string | null;
	extracted_content: string | null;
	include_extracted_content_only_once: boolean;
	include_in_memory: boolean;

	constructor(init: ActionResultInit = {}) {
		this.is_done = init.is_done ?? false;
		this.success = init.success ?? null;
		this.error = init.error ?? null;
		this.attachments = init.attachments ?? null;
		this.long_term_memory = init.long_term_memory ?? null;
		this.extracted_content = init.extracted_content ?? null;
		this.include_extracted_content_only_once = init.include_extracted_content_only_once ?? false;
		this.include_in_memory = init.include_in_memory ?? false;
		this.validate();
	}

	private validate() {
		if (this.success === true && this.is_done !== true) {
			throw new Error(
				'success=True can only be set when is_done=True. For regular actions that succeed, leave success as None. Use success=False only for actions that fail.',
			);
		}
	}

	toJSON() {
		return {
			is_done: this.is_done,
			success: this.success,
			error: this.error,
			attachments: this.attachments,
			long_term_memory: this.long_term_memory,
			extracted_content: this.extracted_content,
			include_extracted_content_only_once: this.include_extracted_content_only_once,
			include_in_memory: this.include_in_memory,
		};
	}
}

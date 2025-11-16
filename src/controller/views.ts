import { z } from 'zod';

export const SearchGoogleActionSchema = z.object({
	query: z.string(),
});
export type SearchGoogleAction = z.infer<typeof SearchGoogleActionSchema>;

export const GoToUrlActionSchema = z.object({
	url: z.string(),
	new_tab: z.boolean().default(false),
});
export type GoToUrlAction = z.infer<typeof GoToUrlActionSchema>;

export const ClickElementActionSchema = z.object({
	index: z.number().int(),
});
export type ClickElementAction = z.infer<typeof ClickElementActionSchema>;

export const InputTextActionSchema = z.object({
	index: z.number().int(),
	text: z.string(),
});
export type InputTextAction = z.infer<typeof InputTextActionSchema>;

export const DoneActionSchema = z.object({
	text: z.string(),
	success: z.boolean(),
	files_to_display: z.array(z.string()).default([]),
});
export type DoneAction = z.infer<typeof DoneActionSchema>;

export const StructuredOutputActionSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
	z.object({
		success: z.boolean().default(true),
		data: dataSchema,
	});
export type StructuredOutputAction<T> = {
	success: boolean;
	data: T;
};

export const SwitchTabActionSchema = z.object({
	page_id: z.number().int(),
});
export type SwitchTabAction = z.infer<typeof SwitchTabActionSchema>;

export const CloseTabActionSchema = z.object({
	page_id: z.number().int(),
});
export type CloseTabAction = z.infer<typeof CloseTabActionSchema>;

export const ScrollActionSchema = z.object({
	down: z.boolean(),
	num_pages: z.number(),
	index: z.number().int().optional(),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

export const SendKeysActionSchema = z.object({
	keys: z.string(),
});
export type SendKeysAction = z.infer<typeof SendKeysActionSchema>;

export const UploadFileActionSchema = z.object({
	index: z.number().int(),
	path: z.string(),
});
export type UploadFileAction = z.infer<typeof UploadFileActionSchema>;

export const ExtractPageContentActionSchema = z.object({
	value: z.string(),
});
export type ExtractPageContentAction = z.infer<typeof ExtractPageContentActionSchema>;

export const NoParamsActionSchema = z.object({}).passthrough();
export type NoParamsAction = z.infer<typeof NoParamsActionSchema>;

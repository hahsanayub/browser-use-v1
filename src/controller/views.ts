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

export const WaitActionSchema = z.object({
  seconds: z.number().default(3),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

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

export const StructuredOutputActionSchema = <T extends z.ZodTypeAny>(
  dataSchema: T
) =>
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
  down: z.boolean().default(true), // Default to scroll down
  num_pages: z.number().default(1), // Default to 1 page
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
export type ExtractPageContentAction = z.infer<
  typeof ExtractPageContentActionSchema
>;

export const ExtractStructuredDataActionSchema = z.object({
  query: z.string(),
  extract_links: z.boolean().default(false),
});
export type ExtractStructuredDataAction = z.infer<
  typeof ExtractStructuredDataActionSchema
>;

export const ReadFileActionSchema = z.object({
  file_name: z.string(),
});
export type ReadFileAction = z.infer<typeof ReadFileActionSchema>;

export const WriteFileActionSchema = z.object({
  file_name: z.string(),
  content: z.string(),
  append: z.boolean().optional(),
  trailing_newline: z.boolean().optional(),
  leading_newline: z.boolean().optional(),
});
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

export const ReplaceFileStrActionSchema = z.object({
  file_name: z.string(),
  old_str: z.string(),
  new_str: z.string(),
});
export type ReplaceFileStrAction = z.infer<typeof ReplaceFileStrActionSchema>;

export const ScrollToTextActionSchema = z.object({
  text: z.string(),
});
export type ScrollToTextAction = z.infer<typeof ScrollToTextActionSchema>;

export const DropdownOptionsActionSchema = z.object({
  index: z.number().int(),
});
export type DropdownOptionsAction = z.infer<typeof DropdownOptionsActionSchema>;

export const SelectDropdownActionSchema = z.object({
  index: z.number().int(),
  text: z.string(),
});
export type SelectDropdownAction = z.infer<typeof SelectDropdownActionSchema>;

export const SheetsRangeActionSchema = z.object({
  cell_or_range: z.string(),
});
export type SheetsRangeAction = z.infer<typeof SheetsRangeActionSchema>;

export const SheetsUpdateActionSchema = z.object({
  cell_or_range: z.string(),
  value: z.string(),
});
export type SheetsUpdateAction = z.infer<typeof SheetsUpdateActionSchema>;

export const SheetsInputActionSchema = z.object({
  text: z.string(),
});
export type SheetsInputAction = z.infer<typeof SheetsInputActionSchema>;

export const NoParamsActionSchema = z.object({}).passthrough();
export type NoParamsAction = z.infer<typeof NoParamsActionSchema>;

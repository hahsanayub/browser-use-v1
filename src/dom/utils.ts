export const cap_text_length = (text: string, max_length: number) => {
	if (text.length > max_length) {
		return `${text.slice(0, max_length)}...`;
	}
	return text;
};

import { z } from 'zod';
import { GmailService } from './service.js';
import { Registry } from '../../controller/registry/service.js';

const SendEmailSchema = z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
});

const ListMessagesSchema = z.object({
    query: z.string().optional(),
    maxResults: z.number().optional(),
});

export class GmailActions {
    private service: GmailService;

    constructor() {
        this.service = new GmailService();
    }

    @Registry.action('Send email', { paramModel: SendEmailSchema })
    async sendEmail(params: z.infer<typeof SendEmailSchema>) {
        return this.service.sendMessage(params.to, params.subject, params.body);
    }

    @Registry.action('List messages', { paramModel: ListMessagesSchema })
    async listMessages(params: z.infer<typeof ListMessagesSchema>) {
        return this.service.listMessages(params.query, params.maxResults);
    }
}

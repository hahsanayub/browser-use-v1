import type { Message } from '../../llm/messages.js';

export class HistoryItem {
  constructor(
    public step_number: number | null = null,
    public evaluation_previous_goal: string | null = null,
    public memory: string | null = null,
    public next_goal: string | null = null,
    public action_results: string | null = null,
    public error: string | null = null,
    public system_message: string | null = null
  ) {
    if (this.error && this.system_message) {
      throw new Error(
        'Cannot have both error and system_message at the same time'
      );
    }
  }

  to_string() {
    const stepStr =
      this.step_number != null ? `step_${this.step_number}` : 'step_unknown';
    if (this.error) {
      return `<${stepStr}>\n${this.error}\n</${stepStr}>`;
    }
    if (this.system_message) {
      return `<sys>\n${this.system_message}\n</sys>`;
    }
    const parts: string[] = [];
    if (this.evaluation_previous_goal) {
      parts.push(
        `Evaluation of Previous Step: ${this.evaluation_previous_goal}`
      );
    }
    if (this.memory) {
      parts.push(`Memory: ${this.memory}`);
    }
    if (this.next_goal) {
      parts.push(`Next Goal: ${this.next_goal}`);
    }
    if (this.action_results) {
      parts.push(this.action_results);
    }
    const content = parts.join('\n');
    return `<${stepStr}>\n${content}\n</${stepStr}>`;
  }
}

export class MessageHistory {
  system_message: Message | null = null;
  state_message: Message | null = null;
  context_messages: Message[] = [];

  get_messages() {
    const messages: Message[] = [];
    if (this.system_message) messages.push(this.system_message);
    if (this.state_message) messages.push(this.state_message);
    messages.push(...this.context_messages);
    return messages;
  }
}

export class MessageManagerState {
  history = new MessageHistory();
  tool_id = 1;
  agent_history_items: HistoryItem[] = [
    new HistoryItem(0, null, null, null, null, null, 'Agent initialized'),
  ];
  read_state_description = '';
  compacted_memory: string | null = null;
  compaction_count = 0;
  last_compaction_step: number | null = null;

  get historyMessages() {
    return this.history.get_messages();
  }

  get_messages() {
    return this.history.get_messages();
  }
}

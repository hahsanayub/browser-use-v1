import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserStateHistory } from '../src/browser/views.js';
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentOutput,
  StepMetadata,
} from '../src/agent/views.js';

describe('Agent history metadata alignment', () => {
  it('serializes state_message and step_interval in history payload', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        new AgentOutput({ action: [] }),
        [new ActionResult({ extracted_content: 'done', is_done: true })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        new StepMetadata(10, 15, 1, 3),
        '<agent_state>cached</agent_state>'
      )
    );

    const dumped = history.toJSON();
    expect(dumped.history[0].state_message).toBe(
      '<agent_state>cached</agent_state>'
    );
    expect(dumped.history[0].metadata?.step_interval).toBe(3);
  });

  it('loads state_message and step_interval from saved history file', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ extracted_content: 'result' })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        new StepMetadata(1, 2, 1, 1),
        'snapshot text'
      )
    );

    const filePath = path.join(
      os.tmpdir(),
      `agent-history-metadata-${Date.now()}.json`
    );

    try {
      history.save_to_file(filePath);
      const loaded = AgentHistoryList.load_from_file(filePath, AgentOutput);
      expect(loaded.history[0].state_message).toBe('snapshot text');
      expect(loaded.history[0].metadata?.step_interval).toBe(1);
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
});

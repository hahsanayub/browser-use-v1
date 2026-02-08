import fs from 'node:fs';
import {
  ContentPartImageParam,
  ContentPartTextParam,
  ImageURL,
  SystemMessage,
  UserMessage,
  type Message,
} from '../llm/messages.js';

const truncateText = (
  text: string,
  maxLength: number,
  fromBeginning = false
) => {
  if (text.length <= maxLength) {
    return text;
  }
  if (fromBeginning) {
    return `...[text truncated]${text.slice(-(maxLength - 20))}`;
  }
  return `${text.slice(0, maxLength - 23)}...[text truncated]...`;
};

const encodeImage = (imagePath: string): string | null => {
  try {
    if (!fs.existsSync(imagePath)) {
      return null;
    }
    return fs.readFileSync(imagePath).toString('base64');
  } catch {
    return null;
  }
};

export interface ConstructJudgeMessagesOptions {
  task: string;
  final_result: string;
  agent_steps: string[];
  screenshot_paths: string[];
  max_images?: number;
  ground_truth?: string | null;
  use_vision?: boolean | 'auto';
}

export interface ConstructSimpleJudgeMessagesOptions {
  task: string;
  final_result: string;
  current_date?: string;
}

export const construct_judge_messages = (
  options: ConstructJudgeMessagesOptions
): Message[] => {
  const {
    task,
    final_result,
    agent_steps,
    screenshot_paths,
    max_images = 10,
    ground_truth = null,
    use_vision = true,
  } = options;

  const task_truncated = truncateText(task, 40000);
  const final_result_truncated = truncateText(final_result, 40000);
  const steps_text_truncated = truncateText(agent_steps.join('\n'), 40000);

  const encoded_images: ContentPartImageParam[] = [];
  if (use_vision !== false) {
    const selected =
      screenshot_paths.length > max_images
        ? screenshot_paths.slice(-max_images)
        : screenshot_paths;
    for (const screenshotPath of selected) {
      const encoded = encodeImage(screenshotPath);
      if (!encoded) {
        continue;
      }
      encoded_images.push(
        new ContentPartImageParam(
          new ImageURL(`data:image/png;base64,${encoded}`, 'auto', 'image/png')
        )
      );
    }
  }

  const ground_truth_section = ground_truth
    ? `
**GROUND TRUTH VALIDATION (HIGHEST PRIORITY):**
The <ground_truth> section contains verified correct information for this task. This can be:
- Evaluation criteria: Specific conditions that must be met.
- Factual answers: The correct answer for retrieval tasks.
- Expected outcomes: What should happen after completion.

The ground truth takes ABSOLUTE precedence over all other evaluation criteria.
If the ground truth is not satisfied, verdict MUST be false.
`
    : '';

  const system_prompt = `You are an expert judge evaluating browser automation agent performance.

<evaluation_framework>
${ground_truth_section}
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. Task Satisfaction (Most Important): Did the agent accomplish what the user asked for?
2. Output Quality: Is the final result in the correct format and complete?
3. Tool Effectiveness: Did the browser interactions work as expected?
4. Agent Reasoning: Decision-making quality throughout the trajectory.
5. Browser Handling: Navigation stability, error recovery, and technical execution.

**VERDICT GUIDELINES:**
- true: Task completed as requested, all key criteria met.
- false: Task not completed, partially completed, or fabricated.

**FAILURE CONDITIONS (automatically set verdict to false):**
- Blocked by captcha or missing authentication.
- Output format wrong or missing.
- Infinite loops or severe technical failures.
- Critical user requirements ignored.
- Browser/page failures preventing required actions.
- Done called before completing key requirements.

**IMPOSSIBLE TASK DETECTION:**
Set impossible_task=true only when completion was fundamentally impossible
due to external constraints (auth missing, broken site, inaccessible pages, etc.).

**CAPTCHA DETECTION:**
Set reached_captcha=true if screenshots/trace indicate anti-bot verification.

**IMPORTANT EVALUATION NOTES:**
- Verify that actions actually happened, not just claimed.
- Screenshot may be partial; agent can still extract from full DOM.
- Ignore date variability: traces can come from different dates.
- Be strict against over-claiming success.
</evaluation_framework>

<response_format>
Respond with EXACTLY this JSON structure (no extra text):
{
  "reasoning": "Detailed analysis",
  "verdict": true or false,
  "failure_reason": "Empty when verdict=true",
  "impossible_task": true or false,
  "reached_captcha": true or false
}
</response_format>`;

  const ground_truth_prompt = ground_truth
    ? `
<ground_truth>
${ground_truth}
</ground_truth>
`
    : '';

  const user_prompt = `<task>
${task_truncated || 'No task provided'}
</task>
${ground_truth_prompt}
<agent_trajectory>
${steps_text_truncated || 'No agent trajectory provided'}
</agent_trajectory>

<final_result>
${final_result_truncated || 'No final result provided'}
</final_result>

${encoded_images.length} screenshots from execution are attached.

Evaluate this agent execution and respond with the exact JSON structure requested.`;

  const content_parts: Array<ContentPartTextParam | ContentPartImageParam> = [
    new ContentPartTextParam(user_prompt),
  ];
  content_parts.push(...encoded_images);

  return [new SystemMessage(system_prompt), new UserMessage(content_parts)];
};

export const construct_simple_judge_messages = (
  options: ConstructSimpleJudgeMessagesOptions
): Message[] => {
  const task_truncated = truncateText(options.task, 20000);
  const final_result_truncated = truncateText(options.final_result, 20000);
  const current_date = options.current_date ?? new Date().toISOString().slice(0, 10);

  const system_prompt = `You are a strict verifier checking whether a browser automation agent actually completed its task.

Today's date is ${current_date}. The agent ran recently - dates near today are expected and NOT fabricated.

Given the task and the agent's final response, determine if the response genuinely satisfies ALL requirements.

Check for these common failure patterns:
1. Incorrect data: Wrong number of items, missing filters/criteria, wrong format
2. Unverified actions: Agent claims completion without clear evidence
3. Incomplete results: Some requirements from the task are not addressed
4. Fabricated content: Data that looks plausible but was not actually extracted. Dates/times near ${current_date} are NOT fabricated.
5. Partial completion reported as success: Response mentions blockers (captcha/access) but still claims success

Respond with EXACTLY this JSON structure:
{
  "is_correct": true or false,
  "reason": "Brief explanation if not correct, empty string if correct"
}

Be strict: if the response does not clearly satisfy every requirement, set is_correct to false.`;

  const user_prompt = `<task>
${task_truncated || 'No task provided'}
</task>

<agent_final_response>
${final_result_truncated || 'No response provided'}
</agent_final_response>

Does the agent's response fully satisfy all requirements of the task? Respond with the JSON structure.`;

  return [new SystemMessage(system_prompt), new UserMessage(user_prompt)];
};

import { describe, expect, it, vi } from 'vitest';
import { CloudSkillService } from '../src/skills/service.js';

const makeSkillItem = (id: string, title = id) => ({
  id,
  title,
  description: `Skill ${title}`,
  status: 'finished',
  parameters: [{ name: 'query', type: 'string', required: true }],
  output_schema: {},
});

describe('CloudSkillService alignment', () => {
  it('exposes cached skills through get_skill()', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [makeSkillItem('skill-1', 'Skill One')],
      }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skill = await service.get_skill('skill-1');
    expect(skill?.title).toBe('Skill One');
    expect(await service.get_skill('missing')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps initialization failure one-shot to avoid retry loops', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    const service = new CloudSkillService({
      skill_ids: ['*'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    await expect(service.get_all_skills()).rejects.toThrow('network down');
    await expect(service.get_all_skills()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads wildcard skills from only the first page', async () => {
    const pageItems = Array.from({ length: 100 }, (_, index) =>
      makeSkillItem(`skill-${index}`)
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: pageItems }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['*'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skills = await service.get_all_skills();
    expect(skills).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters explicit skill IDs and excludes unavailable ones', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [makeSkillItem('skill-a'), makeSkillItem('skill-b')],
      }),
    }));

    const service = new CloudSkillService({
      skill_ids: ['skill-a', 'skill-missing'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const skills = await service.get_all_skills();
    expect(skills.map((entry) => entry.id)).toEqual(['skill-a']);
  });

  it('returns python-aligned execute failure envelope with error type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [makeSkillItem('skill-1')],
        }),
      })
      .mockRejectedValueOnce(new Error('boom'));

    const service = new CloudSkillService({
      skill_ids: ['skill-1'],
      api_key: 'test-key',
      base_url: 'https://api.test',
      fetch_impl: fetchMock as any,
    });

    const result = await service.execute_skill({
      skill_id: 'skill-1',
      parameters: { query: 'weather' },
      cookies: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to execute skill: Error: boom');
  });
});

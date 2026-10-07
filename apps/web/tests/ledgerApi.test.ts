import { expect, it, vi } from 'vitest';
import { createServerApiClient } from '../app/lib/serverApi';
it('new workspace methods use explicit scoped routes and deduplicate selected workspace IDs', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  const client = createServerApiClient({ baseUrl: 'http://localhost:9999', fetchImpl: fetchImpl as typeof fetch })!;
  await client.createWorkspace({ name: 'Travel', initialBudget: { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] } }, 'synthetic-test');
  await client.renameWorkspace('one/two', 'Personal', 'synthetic-test');
  await client.aggregateWorkspaces(['one', 'one', 'two'], 'synthetic-test');
  expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual(['http://localhost:9999/workspaces', 'http://localhost:9999/workspaces/one%2Ftwo', 'http://localhost:9999/workspaces/aggregate']);
  expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ workspaceIds: ['one', 'two'] });
});
it('creation aborts after 15 seconds and performs exactly one POST without retry', async () => {
  vi.useFakeTimers();
  try {
    const fetchImpl = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = createServerApiClient({ baseUrl: 'http://localhost:9999', fetchImpl: fetchImpl as typeof fetch })!;
    const pending = client.createWorkspace({ name: 'New', initialBudget: { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] } }, 'synthetic-test');
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

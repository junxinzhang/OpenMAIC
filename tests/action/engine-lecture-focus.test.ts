import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ActionEngine } from '@/lib/action/engine';
import type { StageStore } from '@/lib/api/stage-api';
const canvas = vi.hoisted(() => ({
  setSpotlight: vi.fn(),
  setLaser: vi.fn(),
  clearAllEffects: vi.fn(),
}));
vi.mock('@/lib/api/stage-api', () => ({ createStageAPI: () => ({}) }));
vi.mock('@/lib/store/canvas', () => ({ useCanvasStore: { getState: () => canvas } }));
vi.mock('@/lib/store/whiteboard-history', () => ({
  useWhiteboardHistoryStore: { getState: () => ({}) },
}));
vi.mock('@/lib/store/media-generation', () => ({
  isMediaPlaceholder: () => false,
  useMediaGenerationStore: { getState: () => ({ tasks: {} }), subscribe: vi.fn() },
}));
vi.mock('@/lib/i18n', () => ({ getClientTranslation: () => '' }));
const store = {} as StageStore;
describe('lecture focus lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  test('a long narration retains its focus and scene cleanup removes it', async () => {
    const engine = new ActionEngine(store);
    await engine.execute(
      { id: 'focus', type: 'spotlight', elementId: 'card' },
      { holdEffect: true },
    );
    await vi.advanceTimersByTimeAsync(45000);
    expect(canvas.setSpotlight).toHaveBeenCalledWith('card', { dimness: 0.5 });
    expect(canvas.clearAllEffects).not.toHaveBeenCalled();
    engine.clearEffects();
    expect(canvas.clearAllEffects).toHaveBeenCalledOnce();
    engine.dispose();
  });
  test('an older transient effect cannot clear a newer lecture focus', async () => {
    const engine = new ActionEngine(store);
    await engine.execute({ id: 'old', type: 'laser', elementId: 'old' });
    await vi.advanceTimersByTimeAsync(3000);
    await engine.execute({ id: 'new', type: 'spotlight', elementId: 'new' }, { holdEffect: true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(canvas.clearAllEffects).not.toHaveBeenCalled();
    engine.dispose();
  });
  test('ordinary interactive effects still clear automatically', async () => {
    const engine = new ActionEngine(store);
    await engine.execute({ id: 'ordinary', type: 'spotlight', elementId: 'card' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(canvas.clearAllEffects).toHaveBeenCalledOnce();
    engine.dispose();
  });
});

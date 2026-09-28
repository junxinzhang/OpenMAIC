'use client';

import { useRef, useState } from 'react';
import { Loader2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { useStageStore, flushStageSave } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { regenerateSpeechAudio } from '@/lib/audio/regenerate-speech-tts';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Fill missing narration on an existing classroom, persisting each completed line. */
export function NarrationFillButton() {
  const { locale: language } = useI18n();
  const zh = language.startsWith('zh');
  const stageId = useStageStore((s) => s.stage?.id);
  const allowed = useMayGenerateForStage(stageId);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const controller = useRef<AbortController | null>(null);
  if (!allowed) return null;

  const run = async () => {
    if (controller.current) {
      controller.current.abort();
      return;
    }
    const settings = useSettingsStore.getState();
    if (!settings.ttsEnabled || settings.ttsProviderId === 'browser-native-tts') {
      toast.error(
        zh
          ? '请先在语音合成设置中启用已配置的语音服务。'
          : 'Enable a configured speech service in settings first.',
      );
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    let completed = 0;
    let failed = 0;
    let lastError = '';
    try {
      const snapshot = useStageStore.getState().scenes;
      // Split only unvoiced lines; never invalidate an existing paid clip.
      for (const scene of snapshot) {
        const actions = (scene.actions ?? []).flatMap((action) =>
          action.type === 'speech' && !action.audioId
            ? splitLongSpeechActions([action], settings.ttsProviderId)
            : [action],
        );
        if (actions.length !== (scene.actions ?? []).length)
          useStageStore.getState().updateScene(scene.id, { actions });
      }
      const queue = useStageStore
        .getState()
        .scenes.flatMap((scene) =>
          (scene.actions ?? []).flatMap((action) =>
            action.type === 'speech' &&
            action.text.trim() &&
            (!action.audioId || action.audioInvalidated)
              ? [{ sceneId: scene.id, actionId: action.id }]
              : [],
          ),
        );
      setProgress({ done: 0, total: queue.length });
      for (const item of queue) {
        if (
          abort.signal.aborted ||
          useStageStore.getState().stage?.id !== stageId ||
          useSettingsStore.getState().ttsProviderId !== settings.ttsProviderId
        ) {
          abort.abort();
          break;
        }
        const scene = useStageStore.getState().scenes.find((s) => s.id === item.sceneId);
        const action = scene?.actions?.find((a) => a.id === item.actionId);
        if (!scene || action?.type !== 'speech' || (action.audioId && !action.audioInvalidated))
          continue;
        try {
          const audioId = await regenerateSpeechAudio(scene.order, action, language, abort.signal);
          if (!audioId)
            throw new Error(
              zh
                ? '未生成语音，请检查语音配置。'
                : 'No audio was generated. Check speech settings.',
            );
          const current = useStageStore.getState().scenes.find((s) => s.id === item.sceneId);
          const currentAction = current?.actions?.find((a) => a.id === item.actionId);
          if (
            useStageStore.getState().stage?.id !== stageId ||
            currentAction?.type !== 'speech' ||
            currentAction.text !== action.text
          )
            throw new Error(
              zh ? '讲解内容已变化，请重新生成。' : 'Narration changed. Please retry.',
            );
          useStageStore.getState().updateScene(item.sceneId, {
            actions: (current!.actions ?? []).map((a) =>
              a.id === item.actionId && a.type === 'speech'
                ? { ...a, audioId, audioInvalidated: false }
                : a,
            ),
          });
          await flushStageSave();
          completed++;
        } catch (error) {
          if (abort.signal.aborted) break;
          failed++;
          lastError = error instanceof Error ? error.message : String(error);
        }
        setProgress({ done: completed + failed, total: queue.length });
      }
      await flushStageSave();
      if (failed)
        toast.error(
          zh
            ? `已完成 ${completed} 段，${failed} 段失败：${lastError}`
            : `${completed} completed; ${failed} failed: ${lastError}`,
          { duration: 12000 },
        );
      else
        toast.success(
          zh
            ? `${abort.signal.aborted ? '已停止' : '配音已补齐'}，本次保存 ${completed} 段。`
            : `${abort.signal.aborted ? 'Stopped' : 'Narration completed'}; ${completed} clips saved.`,
          { duration: 12000 },
        );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      controller.current = null;
      setProgress(null);
    }
  };
  const label = progress
    ? `${zh ? '停止配音' : 'Stop narration'} ${progress.done}/${progress.total}`
    : zh
      ? '补齐课堂配音'
      : 'Fill classroom narration';
  return (
    <button
      onClick={run}
      title={label}
      aria-label={label}
      className="flex items-center gap-1.5 rounded-full px-2.5 py-2 text-xs text-gray-500 hover:bg-muted dark:text-gray-400"
    >
      {progress ? <Loader2 className="size-4 animate-spin" /> : <Volume2 className="size-4" />}
      <span>{label}</span>
    </button>
  );
}

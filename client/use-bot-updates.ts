import { useEffect, useState } from 'react';
import { usePaseo } from '@getpaseo/plugin/client';
import { observeAgentChanges } from './agent-changes.js';

export function useBotUpdates(botId: string, scheduleIds: string[] = []) {
  const api = usePaseo();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const schedules = JSON.stringify(scheduleIds);
  useEffect(() => {
    setError('');
    const observer = observeAgentChanges(api, [{ 'paseo-guys.bot': botId }, ...scheduleIds.map(id => ({ 'paseo.schedule-id': id }))], () => { setError(''); setRevision(value => value + 1); }, failure => setError(String(failure)));
    return () => { void observer.release().catch(error => console.error('同事状态订阅清理失败', error)); };
  }, [api, botId, schedules]);
  return { revision, error };
}

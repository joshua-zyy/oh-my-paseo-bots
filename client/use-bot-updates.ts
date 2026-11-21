import { useEffect, useState } from 'react';
import { usePaseo } from '@getpaseo/plugin/client';
import { observeAgentChanges } from './agent-changes.js';

export function useBotUpdates(botId: string) {
  const api = usePaseo();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    const observer = observeAgentChanges(api, [{ 'paseo-guys.bot': botId }], () => { setError(''); setRevision(value => value + 1); }, failure => setError(String(failure)));
    return () => { void observer.release().catch(error => console.error('同事状态订阅清理失败', error)); };
  }, [api, botId]);
  return { revision, error };
}

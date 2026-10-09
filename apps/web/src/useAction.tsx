import { useRef, useState } from 'react';
import { errorMessage } from './api';

/** Writes are never retried; the caller refreshes server state after confirmation. */
export function useAction() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function run(action: () => Promise<void>, message: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      await action();
      setSuccess(message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, error, success, run };
}

export function ActionFeedback({ error, success }: { error: string; success: string }) {
  return <>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {success && <p className="notice positive" role="status">{success}</p>}
  </>;
}

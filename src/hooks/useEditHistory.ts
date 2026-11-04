import { useCallback, useRef, useState } from 'react';
import { EditHistory } from '../lib/editHistory';
import type { EditAction } from '../pages/EditorPage';

export function useEditHistory() {
  const history = useRef(new EditHistory<EditAction>());
  const [actions, publish] = useState<EditAction[]>([]);
  const set = useCallback((update: EditAction[] | ((current: EditAction[]) => EditAction[])) => {
    history.current.set(typeof update === 'function' ? update(history.current.current) : update);
    publish(history.current.current);
  }, []);
  const hydrate = useCallback((actions: EditAction[]) => {
    history.current.hydrate(actions);
    publish(history.current.current);
  }, []);
  const undo = useCallback(() => { history.current.undo(); publish(history.current.current); }, []);
  const redo = useCallback(() => { history.current.redo(); publish(history.current.current); }, []);
  return { actions, set, hydrate, undo, redo, current: history };
}

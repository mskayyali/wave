import { TranscriptEditor, type TranscriptEditorProps } from './TranscriptEditor';

/** Both layouts share the same document, selection and pause editing engine. */
export function SegmentsView(props: Omit<TranscriptEditorProps, 'layout'>) {
  return <TranscriptEditor {...props} layout="segments" />;
}

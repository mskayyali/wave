import type { CSSProperties } from 'react';

// What a background job is doing, as a small animated icon: captions typing
// themselves for transcription, an arrow dropping into its tray for a
// download, and so on (the motion is in global.scss, "Job icons").
//
// The shapes are Phosphor Icons (regular weight, 256 grid; MIT licence,
// © 2023 Phosphor Icons, https://phosphoricons.com), split into the parts
// that move. A part keeps its own holes (a ring is one path), so each `d` is
// a whole outline.

export type JobKind =
  | 'import' | 'transcribe' | 'download' | 'speakers' | 'enhance'
  | 'realign' | 'export' | 'waveform' | 'playback' | 'other';

/** The kind of job, from its activity id (`transcribe:<projectId>`…). */
export function jobKind(id: string): JobKind {
  const prefix = id.split(':')[0];
  switch (prefix) {
    case 'import':     return 'import';
    case 'transcribe': return 'transcribe';
    case 'download':   return 'download';
    case 'update':     return 'download';
    case 'speakers':   return 'speakers';
    case 'enhance':    return 'enhance';
    case 'realign':    return 'realign';
    case 'export':     return 'export';
    case 'waveform':   return 'waveform';
    case 'playback':   return 'playback';
    default:           return 'other';
  }
}

/** A path, and the name of the part it plays in the animation. */
type Part = [part: string, d: string];

const ICONS: Record<JobKind, Part[]> = {
  // FileAudio: the sound wave pulses out of the speaker.
  import: [
    ['still', 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40v80a8,8,0,0,0,16,0V40h88V88a8,8,0,0,0,8,8h48V216H168a8,8,0,0,0,0,16h32a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160Z'],
    ['still', 'M99.06,128.61a8,8,0,0,0-8.72,1.73L68.69,152H48a8,8,0,0,0-8,8v40a8,8,0,0,0,8,8H68.69l21.65,21.66A8,8,0,0,0,104,224V136A8,8,0,0,0,99.06,128.61ZM88,204.69,77.66,194.34A8,8,0,0,0,72,192H56V168H72a8,8,0,0,0,5.66-2.34L88,155.31Z'],
    ['wave', 'M152,180a40.55,40.55,0,0,1-20,34.91A8,8,0,0,1,124,201.09a24.49,24.49,0,0,0,0-42.18A8,8,0,0,1,132,145.09,40.55,40.55,0,0,1,152,180Z'],
  ],
  // Subtitles: the caption lines type themselves out, one after another.
  transcribe: [
    ['still', 'M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm0,144H32V64H224V192Z'],
    ['line', 'M48,136a8,8,0,0,1,8-8H72a8,8,0,0,1,0,16H56A8,8,0,0,1,48,136Z'],
    ['line', 'M208,136a8,8,0,0,1-8,8H104a8,8,0,0,1,0-16h96A8,8,0,0,1,208,136Z'],
    ['line', 'M160,168a8,8,0,0,1-8,8H56a8,8,0,0,1,0-16h96A8,8,0,0,1,160,168Z'],
    ['line', 'M208,168a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h16A8,8,0,0,1,208,168Z'],
  ],
  // DownloadSimple: the arrow drops into the tray.
  download: [
    ['still', 'M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Z'],
    ['arrow', 'M122.34,149.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z'],
  ],
  // UserSound: the voice's waves, near then far.
  speakers: [
    ['still', 'M144,165.68a68,68,0,1,0-71.9,0c-20.65,6.76-39.23,19.39-54.17,37.17a8,8,0,0,0,12.25,10.3C50.25,189.19,77.91,176,108,176s57.75,13.19,77.88,37.15a8,8,0,1,0,12.25-10.3C183.18,185.07,164.6,172.44,144,165.68ZM56,108a52,52,0,1,1,52,52A52.06,52.06,0,0,1,56,108Z'],
    ['wave', 'M207.36,65.6a108.36,108.36,0,0,1,0,84.8,8,8,0,0,1-7.36,4.86,8,8,0,0,1-7.36-11.15,92.26,92.26,0,0,0,0-72.22,8,8,0,0,1,14.72-6.29Z'],
    ['wave', 'M248,108a139,139,0,0,1-11.29,55.15,8,8,0,0,1-14.7-6.3,124.43,124.43,0,0,0,0-97.7,8,8,0,1,1,14.7-6.3A139,139,0,0,1,248,108Z'],
  ],
  // Sparkle: the star breathes, the small ones twinkle.
  enhance: [
    ['star', 'M197.58,129.06,146,110l-19-51.62a15.92,15.92,0,0,0-29.88,0L78,110l-51.62,19a15.92,15.92,0,0,0,0,29.88L78,178l19,51.62a15.92,15.92,0,0,0,29.88,0L146,178l51.62-19a15.92,15.92,0,0,0,0-29.88ZM137,164.22a8,8,0,0,0-4.74,4.74L112,223.85,91.78,169A8,8,0,0,0,87,164.22L32.15,144,87,123.78A8,8,0,0,0,91.78,119L112,64.15,132.22,119a8,8,0,0,0,4.74,4.74L191.85,144Z'],
    ['twinkle', 'M144,40a8,8,0,0,1,8-8h16V16a8,8,0,0,1,16,0V32h16a8,8,0,0,1,0,16H184V64a8,8,0,0,1-16,0V48H152A8,8,0,0,1,144,40Z'],
    ['twinkle', 'M248,88a8,8,0,0,1-8,8h-8v8a8,8,0,0,1-16,0V96h-8a8,8,0,0,1,0-16h8V72a8,8,0,0,1,16,0v8h8A8,8,0,0,1,248,88Z'],
  ],
  // ArrowsInLineHorizontal: the arrows nudge in to the line.
  realign: [
    ['still', 'M136,40V216a8,8,0,0,1-16,0V40a8,8,0,0,1,16,0Z'],
    ['left', 'M69.66,90.34a8,8,0,0,0-11.32,11.32L76.69,120H16a8,8,0,0,0,0,16H76.69L58.34,154.34a8,8,0,0,0,11.32,11.32l32-32a8,8,0,0,0,0-11.32Z'],
    ['right', 'M240,120H179.31l18.35-18.34a8,8,0,0,0-11.32-11.32l-32,32a8,8,0,0,0,0,11.32l32,32a8,8,0,0,0,11.32-11.32L179.31,136H240a8,8,0,0,0,0-16Z'],
  ],
  // Export: the arrow rises out of the box.
  export: [
    ['still', 'M216,112v96a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V112A16,16,0,0,1,56,96H80a8,8,0,0,1,0,16H56v96H200V112H176a8,8,0,0,1,0-16h24A16,16,0,0,1,216,112Z'],
    ['arrow', 'M93.66,69.66,120,43.31V136a8,8,0,0,0,16,0V43.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,69.66Z'],
  ],
  // Waveform: the bars bounce like a level meter.
  waveform: [
    ['bar', 'M56,96v64a8,8,0,0,1-16,0V96a8,8,0,0,1,16,0Z'],
    ['bar', 'M88,24a8,8,0,0,0-8,8V224a8,8,0,0,0,16,0V32A8,8,0,0,0,88,24Z'],
    ['bar', 'M128,56a8,8,0,0,0-8,8V192a8,8,0,0,0,16,0V64A8,8,0,0,0,128,56Z'],
    ['bar', 'M168,88a8,8,0,0,0-8,8v64a8,8,0,0,0,16,0V96A8,8,0,0,0,168,88Z'],
    ['bar', 'M208,72a8,8,0,0,0-8,8v96a8,8,0,0,0,16,0V80A8,8,0,0,0,208,72Z'],
  ],
  // SpeakerSimpleHigh: the sound comes and goes.
  playback: [
    ['still', 'M163.51,24.81a8,8,0,0,0-8.42.88L85.25,80H40A16,16,0,0,0,24,96v64a16,16,0,0,0,16,16H85.25l69.84,54.31A8,8,0,0,0,168,224V32A8,8,0,0,0,163.51,24.81ZM152,207.64,92.91,161.69A7.94,7.94,0,0,0,88,160H40V96H88a7.94,7.94,0,0,0,4.91-1.69L152,48.36Z'],
    ['bar', 'M208,104v48a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z'],
    ['bar', 'M240,88v80a8,8,0,0,1-16,0V88a8,8,0,0,1,16,0Z'],
  ],
  // CircleNotch: turning.
  other: [
    ['spin', 'M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z'],
  ],
};

export function JobIcon({ kind, size = 16, still = false, className }: {
  kind:       JobKind;
  size?:      number;
  /** Drawn at rest (a finished job). */
  still?:     boolean;
  className?: string;
}) {
  const classes = ['wave-job-icon', `wave-job-icon--${kind}`, still && 'wave-job-icon--still', className].filter(Boolean).join(' ');
  let n = 0;
  return (
    <svg className={classes} width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden>
      {ICONS[kind].map(([part, d], i) => (
        // `--n` numbers the moving parts of a kind, to stagger them.
        <path key={i} d={d} className={`wave-job-icon__${part}`} style={part === 'still' ? undefined : { '--n': n++ } as CSSProperties} />
      ))}
    </svg>
  );
}

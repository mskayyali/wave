// Minimal typings for signalsmith-stretch (JS/WASM release of Signalsmith Stretch).
// https://github.com/Signalsmith-Audio/signalsmith-stretch — see the package README.
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    /** AudioContext time for this change (the node compensates for its own latency). */
    output?: number;
    active?: boolean;
    /** Position in the input buffer, seconds. */
    input?: number;
    rate?: number;
    semitones?: number;
  }

  export interface StretchNode extends AudioNode {
    /**
     * Append input buffers (one typed array per channel); resolves to the buffer
     * end time. A trailing transfer list moves the arrays instead of copying.
     */
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    /** Drop all input (end time resets to 0), or only buffers ending before `toSeconds`. */
    dropBuffers(toSeconds?: number): Promise<unknown>;
    /**
     * Add a scheduled change. NB (1.3.2): this drops every change whose time is
     * still in the future, not just those after this one.
     */
    schedule(change: StretchSchedule): void;
    /** Report the input read position (seconds) every `seconds` while playing. */
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>;
    start(when?: number): void;
    stop(when?: number): void;
  }

  export default function SignalsmithStretch(
    context: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}

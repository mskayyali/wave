// The EQ presets as the user sees them: a name for the problem each one fixes
// and what it does. Their filters live in src-tauri/src/eq.rs (keep the ids in
// step, and the list in mcp.rs's enhance_audio).

export type EqAmount = 'subtle' | 'medium' | 'strong';

export interface EqPreset {
  id:   string;
  name: string;
  /** What it does, in plain words. */
  note: string;
}

export const EQ_PRESETS: EqPreset[] = [
  { id: 'clearer',    name: 'Clearer',    note: 'Clears muddiness and brings the voice forward. A good place to start.' },
  { id: 'warmer',     name: 'Warmer',     note: 'Adds body to a thin voice, as from a laptop, headset or lapel mic.' },
  { id: 'less-boom',  name: 'Less boom',  note: 'Tames the extra bass of talking right up against the mic.' },
  { id: 'less-boxy',  name: 'Less boxy',  note: 'Reduces the hollow sound of a small room.' },
  { id: 'less-nasal', name: 'Less nasal', note: 'Softens a honky or pinched tone.' },
  { id: 'brighter',   name: 'Brighter',   note: 'Brings back crispness to a dull or muffled voice, also after a heavy clean-up, without sharper S sounds.' },
  { id: 'less-harsh', name: 'Less harsh', note: 'Takes the edge off a piercing voice and softens sharp S sounds.' },
  { id: 'broadcast',  name: 'Broadcast',  note: 'A full, close-up radio sound: body, presence and air. Not for a voice that’s already boomy.' },
];

export const EQ_AMOUNTS: { id: EqAmount; label: string }[] = [
  { id: 'subtle', label: 'Subtle' },
  { id: 'medium', label: 'Medium' },
  { id: 'strong', label: 'Strong' },
];

export function eqName(id: string): string | null {
  return EQ_PRESETS.find((p) => p.id === id)?.name ?? null;
}

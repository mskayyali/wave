import { Modal } from '@carbon/react';
import { Chat, Microphone, TextCreation, PauseOutline, UserMultiple, Waveform } from '@carbon/icons-react';
import { APP_VERSION } from '../../lib/appInfo';
import { BrandHero } from '../brand/BrandHero';
import { ExternalLink } from '../editor/ToolCredit';

// About Wave, from the sidebar's About and the menu's Wave → About Wave: the
// welcome's animation, what Wave is and does, who made it, and the models it
// runs on.

const FEATURES = [
  { Icon: Microphone,        title: 'Transcribes on your Mac',     text: 'Word by word, with each word placed on its audio.' },
  { Icon: TextCreation,      title: 'Edit the text, edit the audio', text: 'Delete words to cut them, or trim to the millisecond on the waveform.' },
  { Icon: PauseOutline,      title: 'Tightens the pauses',         text: 'Shortens long pauses to a natural rhythm, or adds them, in one step.' },
  { Icon: Waveform,          title: 'Ready to publish',            text: 'Removes noise, shapes the voice with EQ and sets the loudness.' },
  { Icon: UserMultiple,      title: 'Knows who’s speaking',        text: 'Names each speaker and finds everything one person said.' },
  { Icon: Chat,              title: 'Works with AI agents',        text: 'Claude or ChatGPT can edit with you, and every change can be undone.' },
];

export function AboutWave({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onRequestClose={onClose} passiveModal size="lg" modalHeading="About Wave" className="wave-about">
      {/* Carbon focuses this on open (data-modal-primary-focus); otherwise the
          close button takes focus and shows its tooltip straight away. */}
      <div className="wave-about__body" data-modal-primary-focus tabIndex={-1}>
        {open && <BrandHero />}

        <div className="wave-about__name">
          <span className="wave-about__wordmark">Wave</span>
          <span className="wave-about__version">Version {APP_VERSION}</span>
        </div>
        <p className="wave-about__intro">
          An audio editor for podcasts that works like a document. Wave transcribes your recording, and you edit the
          audio by editing the words: delete a sentence and it’s gone from the audio, with clean joins. Then export the
          audio, with a transcript and subtitles that match.
        </p>

        <ul className="wave-about__features">
          {FEATURES.map(({ Icon, title, text }) => (
            <li key={title} className="wave-about__feature">
              <Icon size={16} aria-hidden />
              <span>
                <span className="wave-about__feature-title">{title}</span>
                <span className="wave-about__feature-text">{text}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="wave-about__credit">
          <span>Built by <strong>Saleh Kayyali</strong></span>
          <span className="wave-about__links">
            <ExternalLink href="https://x.com/mskayyali">x.com/mskayyali</ExternalLink>
            <ExternalLink href="https://mskayyali.com">mskayyali.com</ExternalLink>
          </span>
        </div>
        <p className="wave-about__models">
          Speech models: Whisper by OpenAI (through whisper.cpp), wav2vec2 by Meta, DPDFNet by Ceva, and Nemotron 3
          Diarization by NVIDIA. MP3 encoding: <ExternalLink href="https://lame.sourceforge.io">LAME</ExternalLink> 3.100,
          under the LGPL, as a separate library inside Wave.
        </p>
      </div>
    </Modal>
  );
}

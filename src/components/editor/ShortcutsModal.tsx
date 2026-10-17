import { Modal } from '@carbon/react';
import { SHORTCUT_GROUPS } from '../../lib/shortcuts';

// The keyboard shortcuts sheet: opened with ? or from the editor's top bar.

interface ShortcutsModalProps {
  open:    boolean;
  onClose: () => void;
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      passiveModal
      size="md"
      modalHeading="Keyboard shortcuts"
      className="wave-shortcuts-modal"
    >
      {/* Carbon focuses this on open (data-modal-primary-focus); otherwise
          the close button takes focus and shows its tooltip straight away. */}
      <div className="wave-shortcuts" data-modal-primary-focus tabIndex={-1}>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="wave-shortcuts__group">
            <h3 className="wave-shortcuts__title">{group.title}</h3>
            <dl className="wave-shortcuts__list">
              {group.items.map((item) => (
                <div key={item.label} className="wave-shortcuts__row">
                  <dt>{item.label}</dt>
                  <dd>
                    {item.keys.map((key) => <kbd key={key} className="wave-kbd">{key}</kbd>)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

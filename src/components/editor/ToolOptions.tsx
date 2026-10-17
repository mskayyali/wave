import { useState, type ReactNode } from 'react';
import { Button, Stack } from '@carbon/react';
import { ChevronDown, ChevronUp } from '@carbon/icons-react';

/** A tool's settings that aren't needed every time, folded away until asked for. */
export function ToolOptions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wave-tool-options">
      <Button kind="ghost" size="sm" renderIcon={open ? ChevronUp : ChevronDown} aria-expanded={open} onClick={() => setOpen(!open)}>
        Options
      </Button>
      {open && <Stack gap={5} className="wave-tool-options__body">{children}</Stack>}
    </div>
  );
}

import { Button } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { useNavigation } from '../../lib/navigation';

/** For a tool whose model isn't downloaded: go to Settings to get it. */
export function OpenSettings() {
  const { openSettings } = useNavigation();
  return (
    <div>
      <Button size="sm" kind="tertiary" renderIcon={ArrowRight} onClick={openSettings}>Open Settings</Button>
    </div>
  );
}

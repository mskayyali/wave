import { Link } from '@carbon/react';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Opens in the browser rather than navigating the app's window. */
export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} inline size="sm" onClick={(e) => { e.preventDefault(); void openUrl(href); }}>
      {children}
    </Link>
  );
}

interface ToolCreditProps {
  model:     string;
  provider?: string;
  url?:      string;
  license?:  { name: string; url: string };
}

/** The attribution a third-party model asks for (Desert Ant Labs by default). */
export function ToolCredit({ model, provider = 'Desert Ant Labs', url = 'https://desertant.com', license }: ToolCreditProps) {
  return (
    <p className="wave-tool-credit">
      {model} · Powered by <ExternalLink href={url}>{provider}</ExternalLink>
      {license && <> · <ExternalLink href={license.url}>{license.name}</ExternalLink></>}
    </p>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, CodeSnippet } from '@carbon/react';
import { Renew, WarningAltFilled } from '@carbon/icons-react';

// If rendering fails, say so and offer a reload, instead of an empty window.
// Edits are saved as they're made, so reloading loses nothing.

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Wave crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="wave-crash cds--g100" role="alert">
        <WarningAltFilled size={32} className="wave-crash__icon" />
        <h1 className="wave-crash__title">Something went wrong</h1>
        <p className="wave-crash__body">Wave hit an error it couldn&apos;t recover from. Your edits are saved; reloading picks up where you were.</p>
        <Button kind="primary" className="wave-btn-accent" renderIcon={Renew} onClick={() => window.location.reload()}>Reload Wave</Button>
        <CodeSnippet type="multi" feedback="Copied" className="wave-crash__details">{`${error.message}\n\n${error.stack ?? ''}`}</CodeSnippet>
      </div>
    );
  }
}

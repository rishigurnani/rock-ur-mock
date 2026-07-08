import { Component, type ReactNode } from 'react';

/** Stops a render error in one area from white-screening the whole app (which
 *  would hide the Drafts panel and its backup controls). Shows a recoverable
 *  fallback instead — saved drafts are untouched in storage. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel" style={{ margin: 12 }}>
        <h2>This view hit an error — your drafts are safe</h2>
        <div className="row"><span className="num">Nothing was lost; saved drafts remain in storage.</span></div>
        <button className="mini primary" onClick={() => this.setState({ error: null })}>Try again</button>{' '}
        <button className="mini" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

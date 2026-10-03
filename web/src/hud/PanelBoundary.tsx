import { Component, type ReactNode } from "react";
import hud from "./hud.module.css";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps one broken panel from taking the console down; the error goes to the log. */
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.name} panel failed:`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className={hud.panel} role="alert">
        <div className={hud.empty}>
          <strong>The {this.props.name.toLowerCase()} panel hit a problem</strong>
          {this.state.error.message}
          <div style={{ marginTop: 10 }}>
            <button type="button" className={hud.button} onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }
}

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Ограда вокруг приложения: без неё любая ошибка при отрисовке оставляет
 * пустое окно с одним фоном, и понять, что случилось, невозможно.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class Crash extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Лаунчер упал при отрисовке", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <h2>Лаунчер споткнулся</h2>
        <pre>{error.message}</pre>
        <button className="Button Button_secondary" onClick={() => window.location.reload()}>
          Перезапустить окно
        </button>
      </div>
    );
  }
}

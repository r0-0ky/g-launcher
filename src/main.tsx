import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Crash } from "./components/Crash";
// Стили кнопок minecraft-react-ui идут первыми: наши правила ниже их дополняют.
import "./assets/minecraft-react-ui.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Crash>
      <App />
    </Crash>
  </React.StrictMode>
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Стили кнопок из minecraft-react-ui идут первыми: наши правила ниже их дополняют.
import "minecraft-react-ui/build/minecraft-react-ui.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installNoAutocorrect } from "./app/noAutocorrect";
import "./design/tokens.css";

installNoAutocorrect();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

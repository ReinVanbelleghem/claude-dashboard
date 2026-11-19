import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import { installWindowActivity } from "./windowActivity.ts";

installWindowActivity();

createRoot(document.getElementById("root")!).render(<App />);

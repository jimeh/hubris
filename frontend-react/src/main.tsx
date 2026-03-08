import { createRoot } from "react-dom/client";
import "./app.css";
import App from "./App";

// StrictMode intentionally omitted — its double-mount cycle
// breaks WebSocket connections in TerminalTab (causes ECONNRESET
// on the Vite proxy as the first connection is immediately torn down).
createRoot(document.getElementById("app")!).render(<App />);

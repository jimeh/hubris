import { createRoot } from "react-dom/client";
import "./app.css";
import App from "./App";
import { bootstrapApp } from "@/lib/bootstrap";

bootstrapApp();

const container = document.getElementById("app");

if (!container) {
  throw new Error("App container not found");
}

createRoot(container).render(<App />);

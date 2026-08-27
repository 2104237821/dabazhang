import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>打八张正在构建中</main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);

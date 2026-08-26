import { createRoot } from "react-dom/client";

import { AdminConsole } from "./admin-console.js";

const root = document.getElementById("admin-root");
if (!root) throw new Error("Missing #admin-root");
createRoot(root).render(<AdminConsole />);

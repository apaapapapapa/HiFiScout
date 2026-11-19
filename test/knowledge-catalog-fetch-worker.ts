import { KnowledgeSourceFetchBudget } from "../src/knowledge-catalog/fetch-budget.js";

/** Local workerd fixture: all outbound requests go to an in-process origin Worker. */
export default {
  async fetch(request: Request): Promise<Response> {
    const budget = new KnowledgeSourceFetchBudget();
    try {
      if (new URL(request.url).pathname === "/budget") {
        let completed = 0;
        for (let i = 0; i < KnowledgeSourceFetchBudget.limit; i += 1) {
          const response = await budget.fetch("https://source.invalid/product");
          if ((await response.text()) === "official product") completed += 1;
        }
        let rejected = "";
        try {
          await budget.fetch("https://source.invalid/product");
        } catch (error) {
          rejected = error instanceof Error ? error.message : String(error);
        }
        let interrupted = false;
        try {
          budget.assertComplete();
        } catch {
          interrupted = true;
        }
        return Response.json({ completed, rejected, interrupted, exhausted: budget.exhausted });
      }

      const response = await budget.fetch("https://source.invalid/redirect", {
        redirect: "follow",
      });
      const body = await response.text();
      budget.assertComplete();
      return Response.json({
        status: response.status,
        body,
        location: response.headers.get("location"),
      });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  },
};

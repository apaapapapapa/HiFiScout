import { parseAuctionAdminCommand } from "../api/admin-auction-contracts.js";
import { yahooAuctionCategory } from "./yahoo/policy.js";
/** Named service capability only; public HTTP does not route admin operations. */
export async function administerAuctions(
  env: Env,
  input: unknown,
): Promise<{ status: number; data: unknown }> {
  const command = parseAuctionAdminCommand(input);
  if (!command || command.categories?.some((id) => !yahooAuctionCategory(id)))
    return { status: 400, data: { error: "invalid_auction_control" } };
  const read = command.action === "status";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await env.YAHOO_AUCTIONS.get(
      env.YAHOO_AUCTIONS.idFromName("yahoo-auctions-v1"),
    ).fetch(
      new Request(`https://auction.internal/admin/${read ? "status" : "control"}`, {
        method: read ? "GET" : "POST",
        signal: controller.signal,
        ...(read
          ? {}
          : { body: JSON.stringify(command), headers: { "content-type": "application/json" } }),
      }),
    );
    return { status: response.status, data: await response.json() };
  } catch {
    return { status: 503, data: { error: "auction_admin_unavailable" } };
  } finally {
    clearTimeout(timer);
  }
}

import typedocSidebar from "../reference/api/typedoc-sidebar.json";

const configuredBase = process.env.DOCS_BASE?.trim();
const base = configuredBase ? `${configuredBase.replace(/\/+$/, "")}/` : "/";

export default {
  lang: "en-US",
  title: "HiFiScout Developer Docs",
  description: "Generated and curated implementation documentation for HiFiScout.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/" },
      { text: "Architecture", link: "/data-platform-architecture" },
      { text: "AI Architecture", link: "/ai-generated/architecture-overview" },
      { text: "HTTP API", link: "/reference/http-api" },
      { text: "Source API", link: "/reference/api/" },
      { text: "Database", link: "/database/" },
    ],
    sidebar: [
      {
        text: "Overview",
        items: [{ text: "Developer Guide", link: "/" }],
      },
      {
        text: "Architecture",
        items: [
          { text: "Data Platform", link: "/data-platform-architecture" },
          { text: "Crawl Orchestration", link: "/crawl-orchestration" },
          { text: "Architecture Graph", link: "/architecture/dependencies" },
          { text: "AI-assisted Snapshot", link: "/ai-generated/architecture-overview" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "HTTP API", link: "/reference/http-api" },
          { text: "Source API", link: "/reference/api/", items: typedocSidebar },
          { text: "Database Schema", link: "/database/" },
        ],
      },
      {
        text: "Data and Operations",
        items: [
          { text: "Data Quality", link: "/data-quality" },
          { text: "Remediation Runbook", link: "/data-quality-remediation" },
          { text: "Resolver Replay", link: "/resolver-replay-status" },
          { text: "Registered Product Admin", link: "/listing-admin" },
          { text: "R2 Evidence Limits", link: "/r2-evidence-safety" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Adding Shops", link: "/adding-shops" },
          { text: "TypeScript", link: "/typescript" },
          { text: "Testing Strategy", link: "/testing-strategy" },
          { text: "Documentation Tooling", link: "/tooling" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/apaapapapapa/HiFiScout" }],
  },
};

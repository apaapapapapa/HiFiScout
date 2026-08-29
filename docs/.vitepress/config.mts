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
          { text: "Module Dependencies", link: "/architecture/dependencies" },
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
        text: "Development",
        items: [
          { text: "Adding Shops", link: "/adding-shops" },
          { text: "Testing Strategy", link: "/testing-strategy" },
          { text: "Documentation Tooling", link: "/tooling" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/apaapapapapa/HiFiScout" }],
  },
};

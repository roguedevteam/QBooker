import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// SEO basics that depend on the public site URL (VITE_MARKETING_URL, no trailing slash):
//  - canonical + og:url tags and JSON-LD in index.html (the <!--seo--> marker)
//  - sitemap.xml and a robots.txt that points at it, written into dist/
// With the variable unset the tags are omitted and robots.txt stays generic (no sitemap).
function seoPlugin(siteUrl) {
  const pages = ["/", "/privacy"];
  return {
    name: "qbooker-seo",
    transformIndexHtml(html) {
      const tags = siteUrl
        ? [
            `<link rel="canonical" href="${siteUrl}/" />`,
            `<meta property="og:url" content="${siteUrl}/" />`,
            `<script type="application/ld+json">${JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "QBooker",
              url: `${siteUrl}/`,
            })}</script>`,
          ].join("\n    ")
        : "";
      return html.replace("<!--seo-->", tags);
    },
    closeBundle() {
      if (!siteUrl) return;
      const out = path.resolve("dist");
      if (!fs.existsSync(out)) return;
      const urls = pages.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n");
      fs.writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
      fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  const siteUrl = String(env.VITE_MARKETING_URL || "").trim().replace(/\/+$/, "");
  return {
    plugins: [react(), seoPlugin(siteUrl)],
    server: { port: 5175 },
  };
});

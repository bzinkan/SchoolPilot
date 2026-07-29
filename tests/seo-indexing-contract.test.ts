import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, it } from "node:test";

import {
  PUBLIC_PAGE_METADATA,
  SITE_ORIGIN,
  getPublicPageMetadata,
  normalizePathname,
} from "../schoolpilot-app/src/seo/routeMetadata.js";

const frontendIndex = readFileSync(
  new URL("../schoolpilot-app/index.html", import.meta.url),
  "utf8",
);
const robots = readFileSync(
  new URL("../schoolpilot-app/public/robots.txt", import.meta.url),
  "utf8",
);
const sitemap = readFileSync(
  new URL("../schoolpilot-app/public/sitemap.xml", import.meta.url),
  "utf8",
);
const cloudFrontFunction = readFileSync(
  new URL("../infra/modules/cdn/spa-rewrite.js", import.meta.url),
  "utf8",
).replace("__CANONICAL_HOST__", "school-pilot.net");

type QueryParameter = {
  value?: string;
  multiValue?: Array<{ value: string }>;
};

type CloudFrontRequest = {
  uri: string;
  headers: { host?: { value: string } };
  querystring: Record<string, QueryParameter>;
};

function invokeCloudFrontFunction(request: CloudFrontRequest) {
  const context = createContext({
    event: { request: structuredClone(request) },
    result: null,
  });
  new Script(`${cloudFrontFunction}\nresult = handler(event);`).runInContext(
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

function request(
  uri: string,
  host = "school-pilot.net",
  querystring: Record<string, QueryParameter> = {},
): CloudFrontRequest {
  return {
    uri,
    headers: { host: { value: host } },
    querystring,
  };
}

describe("SEO indexing contract", () => {
  it("does not hard-code a conflicting canonical in the shared SPA shell", () => {
    assert.doesNotMatch(frontendIndex, /<link rel="canonical"/);
    assert.match(frontendIndex, /<meta name="robots" content="index, follow" \/>/);
    assert.match(frontendIndex, /name="description"/);
  });

  it("keeps the public metadata and sitemap URL sets aligned", () => {
    const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1],
    );
    const metadataUrls = Object.keys(PUBLIC_PAGE_METADATA).map(
      (pathname) => new URL(pathname, SITE_ORIGIN).href,
    );

    assert.deepEqual(sitemapUrls, metadataUrls);
    assert.equal(getPublicPageMetadata("/products/classpilot/")?.title, PUBLIC_PAGE_METADATA["/products/classpilot"].title);
    assert.equal(getPublicPageMetadata("/login"), null);
    assert.equal(normalizePathname("/security///"), "/security");
  });

  it("publishes crawler directives and the sitemap location", () => {
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Allow: \/$/m);
    assert.match(robots, /^Disallow: \/api\/$/m);
    assert.match(
      robots,
      /^Sitemap: https:\/\/school-pilot\.net\/sitemap\.xml$/m,
    );
  });

  it("redirects alternate hosts to the apex and preserves query parameters", () => {
    const result = invokeCloudFrontFunction(
      request("/", "www.school-pilot.net", {
        utm_source: { value: "search console" },
      }),
    );

    assert.equal(result.statusCode, 301);
    assert.equal(
      result.headers.location.value,
      "https://school-pilot.net/?utm_source=search%20console",
    );
  });

  it("redirects visible index files and trailing slashes", () => {
    const indexResult = invokeCloudFrontFunction(request("/index.html"));
    const trailingSlashResult = invokeCloudFrontFunction(
      request("/products/classpilot/"),
    );

    assert.equal(
      indexResult.headers.location.value,
      "https://school-pilot.net/",
    );
    assert.equal(
      trailingSlashResult.headers.location.value,
      "https://school-pilot.net/products/classpilot",
    );
  });

  it("rewrites SPA routes but leaves real files untouched", () => {
    const spaRequest = request("/products/classpilot");
    const staticRequest = request("/robots.txt");

    assert.equal(invokeCloudFrontFunction(spaRequest).uri, "/index.html");
    assert.equal(invokeCloudFrontFunction(staticRequest).uri, "/robots.txt");
  });
});

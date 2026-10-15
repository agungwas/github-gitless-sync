import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { OfficialPackageSource } from "./package-source";

const registryUrl = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const releaseUrl = "https://github.com/publisher/sample/releases/download/1.2.3";
const manifest = {
  id: "sample", name: "Sample", version: "1.2.3", author: "Publisher",
  description: "sample", minAppVersion: "1.0.0", isDesktopOnly: false,
};

function response(status: number, body: unknown = ""): RequestUrlResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: {}, text, json: body, arrayBuffer: new TextEncoder().encode(text).buffer };
}

function setup(styles: string | null = null) {
  const responses = new Map([
    [registryUrl, response(200, [{ id: "sample", repo: "publisher/sample" }])],
    [releaseUrl + "/manifest.json", response(200, manifest)],
    [releaseUrl + "/main.js", response(200, "plugin code")],
    [releaseUrl + "/styles.css", styles === null ? response(404) : response(200, styles)],
  ]);
  vi.mocked(requestUrl).mockImplementation((request) => {
    const url = typeof request === "string" ? request : request.url;
    const result = responses.get(url) ?? response(403, { message: "API rate limit exceeded" });
    return Object.assign(Promise.resolve(result), {
      arrayBuffer: Promise.resolve(result.arrayBuffer), json: Promise.resolve(result.json), text: Promise.resolve(result.text),
    });
  });
  return { source: new OfficialPackageSource(), responses };
}

describe("OfficialPackageSource", () => {
  beforeEach(() => { vi.mocked(requestUrl).mockReset(); });

  it("downloads exact release files without calling the rate-limited API or sending credentials", async () => {
    const { source } = setup();

    const resolved = await source.resolve(manifest);

    expect(resolved).not.toHaveProperty("proof");
    expect(resolved.manifest).toMatchObject({ id: "sample", version: "1.2.3" });
    expect(resolved.assets.mainJs.byteLength).toBeGreaterThan(0);
    expect(resolved.assets.stylesCss).toBeNull();
    expect(vi.mocked(requestUrl).mock.calls.map(([request]) => typeof request === "string" ? request : request.url))
      .toEqual([registryUrl, releaseUrl + "/manifest.json", releaseUrl + "/main.js", releaseUrl + "/styles.css"]);
    for (const [request] of vi.mocked(requestUrl).mock.calls) {
      if (typeof request !== "string") expect(request.headers ?? {}).not.toHaveProperty("Authorization");
    }
  });

  it("refuses to substitute HEAD or latest when the exact release manifest is unavailable", async () => {
    const { source, responses } = setup();
    responses.set(releaseUrl + "/manifest.json", response(404));

    await expect(source.resolve(manifest)).rejects.toThrow("Failed to download manifest.json (HTTP 404)");

    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects an absent executable instead of accepting an incomplete package", async () => {
    const { source, responses } = setup();
    responses.set(releaseUrl + "/main.js", response(404));

    await expect(source.resolve(manifest)).rejects.toThrow("Failed to download main.js (HTTP 404)");
  });

  it("retries registry resolution after a transient registry failure", async () => {
    const { source, responses } = setup();
    responses.set(registryUrl, response(503));
    await expect(source.resolve(manifest)).rejects.toThrow("Official plugin registry unavailable (HTTP 503)");

    responses.set(registryUrl, response(200, [{ id: "sample", repo: "publisher/sample" }]));

    await expect(source.resolve(manifest)).resolves.toHaveProperty("manifest.version", "1.2.3");
  });

  it.each(["body {}", ""])("downloads an existing stylesheet, including an empty asset: %j", async (styles) => {
    const { source } = setup(styles);

    const resolved = await source.resolve(manifest);

    expect(resolved.assets.stylesCss).toEqual(new TextEncoder().encode(styles).buffer);
  });

  it.each([403, 429, 503])("does not mistake stylesheet HTTP %s for an optional missing file", async (status) => {
    const { source, responses } = setup();
    responses.set(releaseUrl + "/styles.css", response(status));

    await expect(source.resolve(manifest)).rejects.toThrow("Failed to download styles.css (HTTP " + status + ")");
  });

  it.each([
    { id: "different" }, { version: "9.9.9" }, { minAppVersion: "9.0.0" }, { isDesktopOnly: true },
  ])("rejects a release manifest that differs from synchronized identity: %j", async (change) => {
    const { source, responses } = setup();
    responses.set(releaseUrl + "/manifest.json", response(200, { ...manifest, ...change }));

    await expect(source.resolve(manifest)).rejects.toThrow("Release manifest does not match synchronized manifest");
  });

  it("enforces the executable size limit", async () => {
    const { source, responses } = setup();
    responses.set(releaseUrl + "/main.js", { ...response(200), arrayBuffer: new ArrayBuffer(25 * 1024 * 1024 + 1) });

    await expect(source.resolve(manifest)).rejects.toThrow("main.js exceeds size limit");
  });
});

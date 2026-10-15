import { beforeEach, describe, expect, it, vi } from "vitest";
import GithubClient from "./client";
import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";

function requestArg(value: string | RequestUrlParam): RequestUrlParam {
  if (typeof value === "string") throw new Error("Expected request options");
  return value;
}

describe("GithubClient credentials", () => {
  it("uses runtime token provider instead of persisted settings token", async () => {
    const client = new GithubClient(
      { githubToken: "legacy-persisted-token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
      async () => "device-secret-token",
    );

    expect(await client.headers()).toMatchObject({
      Authorization: "Bearer device-secret-token",
    });
  });

  it("omits authorization when runtime credential is unavailable", async () => {
    const client = new GithubClient(
      { githubToken: "", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
      async () => null,
    );

    expect(await client.headers()).not.toHaveProperty("Authorization");
  });
});

describe("GithubClient pinned snapshots", () => {
  beforeEach(() => vi.mocked(requestUrl).mockReset());

  it("reads branch commit, tree, and metadata from one pinned revision", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({ status: 200, json: { object: { sha: "commit-1" } } } as never)
      .mockResolvedValueOnce({ status: 200, json: { tree: { sha: "tree-1" } } } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          sha: "tree-1",
          truncated: false,
          tree: [
            { path: ".obsidian/github-sync-metadata.json", mode: "100644", type: "blob", sha: "metadata-blob", size: 40, url: "" },
            { path: "note.md", mode: "100644", type: "blob", sha: "note-blob", size: 4, url: "" },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { content: btoa('{"lastSync":1,"files":{}}') },
      } as never);
    const client = new GithubClient(
      { githubToken: "token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
    );

    const snapshot = await client.getSnapshot({ metadataPath: ".obsidian/github-sync-metadata.json" });

    expect(snapshot.commitSha).toBe("commit-1");
    expect(snapshot.treeSha).toBe("tree-1");
    expect(snapshot.files["note.md"].sha).toBe("note-blob");
    expect(snapshot.metadata).toEqual({ lastSync: 1, files: {} });
    expect(vi.mocked(requestUrl).mock.calls.map(([request]) => requestArg(request).url)).toEqual([
      "https://api.github.com/repos/owner/vault/git/refs/heads/main",
      "https://api.github.com/repos/owner/vault/git/commits/commit-1",
      "https://api.github.com/repos/owner/vault/git/trees/tree-1?recursive=1",
      "https://api.github.com/repos/owner/vault/git/blobs/metadata-blob",
    ]);
  });

  it("does not reject metadata carrying fields from other versions and drops them (T2)", async () => {
    const legacy = {
      lastSync: 1,
      pluginSyncProtocol: 1,
      files: { "note.md": { path: "note.md", sha: "s", dirty: false, justDownloaded: false, lastModified: 1, pluginSource: { kind: "bad" } } },
    };
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({ status: 200, json: { object: { sha: "commit-1" } } } as never)
      .mockResolvedValueOnce({ status: 200, json: { tree: { sha: "tree-1" } } } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: { sha: "tree-1", truncated: false, tree: [
          { path: "m.json", mode: "100644", type: "blob", sha: "metadata-blob", size: 40, url: "" },
        ] },
      } as never)
      .mockResolvedValueOnce({ status: 200, json: { content: btoa(JSON.stringify(legacy)) } } as never);
    const client = new GithubClient(
      { githubToken: "token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
    );

    const snapshot = await client.getSnapshot({ metadataPath: "m.json" });

    expect(snapshot.metadata).toEqual({
      lastSync: 1,
      files: { "note.md": { path: "note.md", sha: "s", dirty: false, justDownloaded: false, lastModified: 1 } },
    });
  });

  it("walks subtree trees when GitHub marks recursive tree response truncated", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({ status: 200, json: { object: { sha: "commit-2" } } } as never)
      .mockResolvedValueOnce({ status: 200, json: { tree: { sha: "tree-2" } } } as never)
      .mockResolvedValueOnce({ status: 200, json: { truncated: true, tree: [] } } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          truncated: false,
          tree: [{ path: "plugins", mode: "040000", type: "tree", sha: "plugins-tree" }],
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          truncated: false,
          tree: [{ path: "quickadd", mode: "040000", type: "tree", sha: "quickadd-tree" }],
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          truncated: false,
          tree: [{ path: "manifest.json", mode: "100644", type: "blob", sha: "manifest-sha", size: 2, url: "" }],
        },
      } as never);
    const client = new GithubClient(
      { githubToken: "token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
    );

    const snapshot = await client.getSnapshot({ metadataPath: ".obsidian/github-sync-metadata.json" });

    expect(snapshot.complete).toBe(true);
    expect(snapshot.files["plugins/quickadd/manifest.json"].sha).toBe("manifest-sha");
  });

  it("publishes a branch update explicitly without force", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, json: {} } as never);
    const client = new GithubClient(
      { githubToken: "token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
    );

    await client.updateBranchHead({ sha: "next-commit" });

    expect(JSON.parse(requestArg(vi.mocked(requestUrl).mock.calls[0][0]).body as string)).toEqual({
      sha: "next-commit",
      force: false,
    });
  });

  it("downloads bootstrap archive by pinned commit", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce({ status: 200, arrayBuffer: new ArrayBuffer(0) } as never);
    const client = new GithubClient(
      { githubToken: "token", githubOwner: "owner", githubRepo: "vault", githubBranch: "main" } as never,
      { error: vi.fn() } as never,
    );
    const downloadPinned = (client as unknown as {
      downloadRepositoryArchive(options: { ref: string }): Promise<ArrayBuffer>;
    }).downloadRepositoryArchive.bind(client);

    await downloadPinned({ ref: "0123456789abcdef" });

    expect(requestArg(vi.mocked(requestUrl).mock.calls[0][0]).url)
      .toContain("/zipball/0123456789abcdef");
  });
});

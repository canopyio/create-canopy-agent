import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { preflightScaffold } from "../src/scaffold.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "canopy-scaffold-test-"));
}

describe("preflightScaffold", () => {
  it("passes when destination is absent", async () => {
    const root = await tempDir();
    await preflightScaffold({
      starterSlug: "research-agent",
      destDir: path.join(root, "new-project"),
    });
  });

  it("passes when destination exists and is empty", async () => {
    const root = await tempDir();
    const destDir = path.join(root, "empty-project");
    await mkdir(destDir);

    await preflightScaffold({ starterSlug: "research-agent", destDir });
  });

  it("fails when destination is non-empty", async () => {
    const root = await tempDir();
    const destDir = path.join(root, "used-project");
    await mkdir(destDir);
    await writeFile(path.join(destDir, "README.md"), "# Existing\n", "utf8");

    await assert.rejects(
      () => preflightScaffold({ starterSlug: "research-agent", destDir }),
      /Destination .* is not empty/,
    );
  });

  it("fails when selected starter template is missing", async () => {
    const root = await tempDir();

    await assert.rejects(
      () =>
        preflightScaffold({
          starterSlug: "missing-agent",
          destDir: path.join(root, "new-project"),
        }),
      /Template not found/,
    );
  });
});
